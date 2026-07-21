import { createHash } from "node:crypto";
import { env } from "./env";

export interface WsUser {
  id: string;
  email?: string;
  name?: string;
}

export interface WsTask {
  id: string;
  name: string;
  page: string;
  status?: string;
  user_from?: WsUser;
  user_to?: WsUser;
  project?: { id: string; name?: string; page?: string };
  text?: string;
}

export interface WsComment {
  id: string;
  text?: string;
  date_added?: string;
  user_from?: WsUser;
}

export interface WsUserFull extends WsUser {
  first_name?: string;
  last_name?: string;
  role?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// hash = MD5(query_string + WS_ADMIN_API_KEY), where query_string is the
// url-encoded string exactly as it goes into the URL, without the hash param.
function buildUrl(params: Record<string, string>): string {
  const queryString = new URLSearchParams(params).toString().replace(/\+/g, "%20");
  const hash = createHash("md5")
    .update(queryString + env("WS_ADMIN_API_KEY"))
    .digest("hex");
  return `https://${env("WS_DOMAIN")}/api/admin/v2/?${queryString}&hash=${hash}`;
}

// Worksection rate limit is 1 req/sec and serverless has no shared memory
// for a counter, so instead of a precise rate limiter we retry with
// exponential backoff on "too many requests".
async function wsRequest<T>(params: Record<string, string>): Promise<T> {
  const url = buildUrl(params);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    let res: Response;
    try {
      res = await fetch(url);
    } catch (e) {
      lastError = e;
      continue;
    }
    const body = (await res.json().catch(() => null)) as
      | { status?: string; message?: string; data?: T }
      | null;
    const rateLimited =
      res.status === 429 ||
      (body?.status === "error" && /too many|rate/i.test(body.message ?? ""));
    if (rateLimited) {
      lastError = new Error(
        `Worksection rate limit (${params.action}): ${body?.message ?? `HTTP ${res.status}`}`
      );
      continue;
    }
    if (!res.ok || !body || body.status !== "ok") {
      throw new Error(
        `Worksection API error (${params.action}): ${body?.message ?? `HTTP ${res.status}`}`
      );
    }
    return body.data as T;
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Worksection request failed: ${params.action}`);
}

// A task as returned by get_all_tasks with extra=tags. `tags` is an object
// { tagId: tagName } that mixes BOTH status-tags and label-tags with no type
// marker — callers must intersect the keys with the known status tag ids
// (see getStatusTagIds) to isolate the status. The key is absent when the task
// has no tags at all.
export interface WsTaskWithTags extends WsTask {
  priority?: string;
  date_added?: string;
  tags?: Record<string, string>;
}

// Empirically verified against production: get_all_tasks DOES honour
// extra=tags, so every active task's tags come back in a single request
// (no per-task get_task fan-out, which would hit the 1 req/sec limit).
export function getAllTasksWithTags(): Promise<WsTaskWithTags[]> {
  return wsRequest<WsTaskWithTags[]>({
    action: "get_all_tasks",
    extra: "tags",
    filter: "active",
  });
}

// The set of tag ids that belong to groups of type `status` (as opposed to
// plain `label` tags). Note the API returns numeric ids while task.tags keys
// are strings, so we normalise to string. One extra request per poll — fine,
// since polling runs only every few minutes.
export function getStatusTagIds(): Promise<Set<string>> {
  return wsRequest<Array<{ id: string | number }>>({
    action: "get_task_tags",
    type: "status",
  }).then((tags) => new Set(tags.map((t) => String(t.id))));
}

export function getTask(taskId: string): Promise<WsTask> {
  return wsRequest<WsTask>({
    action: "get_task",
    id_task: taskId,
    extra: "text,html,subscribers",
  });
}

export function getComments(taskId: string): Promise<WsComment[]> {
  return wsRequest<WsComment[]>({ action: "get_comments", id_task: taskId });
}

export function getUsers(): Promise<WsUserFull[]> {
  return wsRequest<WsUserFull[]>({ action: "get_users" });
}

export function addWebhook(
  url: string,
  events: string[],
  httpUser?: string,
  httpPass?: string
): Promise<unknown> {
  const params: Record<string, string> = {
    action: "add_webhook",
    url,
    events: events.join(","),
  };
  if (httpUser) params.http_user = httpUser;
  if (httpPass) params.http_pass = httpPass;
  return wsRequest<unknown>(params);
}
