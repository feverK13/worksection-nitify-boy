import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getComments, getTask, WsComment, WsTask } from "../lib/worksectionClient";
import { logWebhook, supabase, TaskStateRow } from "../lib/supabaseClient";
import { KNOWN_EVENTS, processEvent, WsEvent } from "../lib/notifier";

function checkBasicAuth(req: VercelRequest): boolean {
  const user = process.env.WEBHOOK_HTTP_USER;
  const pass = process.env.WEBHOOK_HTTP_PASS;
  if (!user && !pass) return true;
  const expected =
    "Basic " + Buffer.from(`${user ?? ""}:${pass ?? ""}`).toString("base64");
  return (req.headers.authorization ?? "") === expected;
}

// The body may arrive as JSON or as application/x-www-form-urlencoded;
// Vercel parses known content-types into req.body, the rest we parse ourselves.
function parseBody(req: VercelRequest): Record<string, unknown> {
  const body = req.body as unknown;
  if (body == null) return {};
  if (typeof body === "object") return body as Record<string, unknown>;
  if (typeof body === "string") {
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      return Object.fromEntries(new URLSearchParams(body));
    }
  }
  return {};
}

// The exact webhook payload schema is undocumented (spec §3.2), so field
// names are probed from a list of likely candidates, dot-paths included.
function pick(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    let value: unknown = payload;
    for (const part of key.split(".")) {
      value =
        value != null && typeof value === "object"
          ? (value as Record<string, unknown>)[part]
          : undefined;
    }
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return null;
}

async function handleEvent(payload: Record<string, unknown>): Promise<void> {
  const rawEvent = pick(payload, ["action", "event", "event_name", "event_type", "type"]);
  const taskId = pick(payload, [
    "id_task",
    "task_id",
    "task.id",
    "data.id_task",
    "data.task_id",
    "id",
  ]);
  const commentId = pick(payload, [
    "id_comment",
    "comment_id",
    "comment.id",
    "data.id_comment",
  ]);

  if (!taskId) {
    console.warn("No task id found in payload — skipping. Payload:", JSON.stringify(payload));
    return;
  }

  let event = (KNOWN_EVENTS as readonly string[]).includes(rawEvent ?? "")
    ? (rawEvent as WsEvent)
    : null;
  if (!event) {
    event = commentId ? "post_comment" : "update_task";
    console.warn(
      `Unknown event "${rawEvent}" — falling back to "${event}" (needs calibration, see raw payload log)`
    );
  }

  // For deleted tasks the API call fails; fall back to the stored state
  // so rule 3 can still notify the (former) responsible.
  let task: WsTask | null = null;
  try {
    task = await getTask(taskId);
  } catch (e) {
    console.warn(`get_task ${taskId} failed (${e}) — falling back to stored state`);
    const { data } = await supabase
      .from("tasks_state")
      .select("*")
      .eq("task_id", taskId)
      .maybeSingle();
    const prev = (data as TaskStateRow | null) ?? null;
    if (prev) {
      task = {
        id: prev.task_id,
        name: prev.name ?? `#${prev.task_id}`,
        page: "",
        status: prev.status ?? undefined,
        user_to: prev.user_to_id
          ? { id: prev.user_to_id, email: prev.user_to_email ?? undefined }
          : undefined,
        project: prev.project_id ? { id: prev.project_id } : undefined,
      };
    }
  }
  if (!task) {
    console.warn(`Task ${taskId} not found in API nor in tasks_state — skipping`);
    return;
  }

  let comment: WsComment | null = null;
  if (commentId && event !== "delete_comment") {
    try {
      const comments = await getComments(taskId);
      comment = comments.find((c) => String(c.id) === commentId) ?? null;
      if (!comment) console.warn(`Comment ${commentId} not found in task ${taskId}`);
    } catch (e) {
      console.warn(`get_comments ${taskId} failed:`, e);
    }
  }

  await processEvent(event, task, comment);
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!checkBasicAuth(req)) {
    res.status(401).json({ status: "unauthorized" });
    return;
  }
  try {
    const payload = parseBody(req);
    if (process.env.DEBUG_LOG_RAW_PAYLOADS === "true") {
      console.log(
        "worksection raw payload:",
        JSON.stringify({ contentType: req.headers["content-type"], body: req.body })
      );
      await logWebhook("worksection", payload);
    }
    await handleEvent(payload);
  } catch (e) {
    console.error("worksection-webhook error:", e);
  }
  // Worksection expects HTTP 200 with {"status":"OK"} within 5 seconds;
  // internal failures are logged above but must not fail the webhook.
  res.status(200).json({ status: "OK" });
}
