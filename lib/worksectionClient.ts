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
