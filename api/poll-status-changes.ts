import type { VercelRequest, VercelResponse } from "@vercel/node";
import { supabase, EmployeeRow, TaskStateRow } from "../lib/supabaseClient";
import {
  getAllTasksWithTags,
  getStatusTagIds,
  WsTaskWithTags,
} from "../lib/worksectionClient";
import { sendMessage } from "../lib/telegramApi";
import { env } from "../lib/env";

// Standalone polling endpoint (NOT a webhook). Worksection does not fire any
// webhook when a task's "status" tag changes in the UI (verified empirically:
// zero inbound requests on such a change). A free external cron (cron-job.org)
// hits this every 3-5 min; we diff each task's current status-tag against the
// value stored on the previous poll and notify the responsible person.
//
// This endpoint is fully independent of api/worksection-webhook.ts.

// Worksection's "Anyone / unassigned" sentinel responsible user.
const ANYONE_ID = "2";

// Safety valve: keep one pass well under the serverless timeout. With the
// linked-responsible filter below the real candidate count is small; this only
// guards against pathological growth. If it ever trips, status polling needs a
// smarter scope (e.g. per-project sharding across runs).
const MAX_TASKS_PER_RUN = 400;

// A tasks_state row that's missing when a task is younger than this counts as
// "just created" (worth a status-set notification) rather than a pre-existing
// task we're merely seeing on our first poll (silent baseline).
const NEW_TASK_THRESHOLD_MINUTES = 15;

function parseWsDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d;
}

function isAuthorized(req: VercelRequest): boolean {
  const secret = process.env.POLL_SECRET;
  if (!secret) {
    console.error("POLL_SECRET is not set — refusing all poll requests");
    return false; // fail closed
  }
  return req.headers.authorization === `Bearer ${secret}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    // 1. Which tag ids are actually "status" tags (task.tags mixes status +
    //    label tags with no type marker).
    const statusTagIds = await getStatusTagIds();

    // 2. All active tasks, with their tags, in one request.
    const allTasks = await getAllTasksWithTags();

    // 3. Linked employees, indexed by ws_user_id.
    const { data: empRows, error } = await supabase
      .from("employees")
      .select("*")
      .eq("is_linked", true);
    if (error) throw new Error(`employees select failed: ${error.message}`);
    const employees = (empRows ?? []) as EmployeeRow[];
    const byWsId = new Map(
      employees.filter((e) => e.ws_user_id).map((e) => [String(e.ws_user_id), e])
    );
    const findEmployee = (id: string | number | null | undefined): EmployeeRow | null =>
      id != null ? byWsId.get(String(id)) ?? null : null;

    // Only tasks whose current responsible is a linked employee can ever
    // produce a notification — that filter is also our bound on work per run
    // (a tighter, correctness-neutral form of "projects with a linked
    // responsible"). Everything else is skipped outright.
    let tasks = allTasks.filter((t) => {
      const rid = t.user_to?.id;
      return rid != null && String(rid) !== ANYONE_ID && findEmployee(rid) != null;
    });

    let truncated = false;
    if (tasks.length > MAX_TASKS_PER_RUN) {
      console.warn(
        `poll: ${tasks.length} candidate tasks exceed cap ${MAX_TASKS_PER_RUN}; ` +
          `truncating this pass. Status changes on the remainder will be missed — ` +
          `time to shard polling by project.`
      );
      tasks = tasks.slice(0, MAX_TASKS_PER_RUN);
      truncated = true;
    }

    // Load all prior states in ONE query (avoids a per-task round trip).
    const taskIds = tasks.map((t) => String(t.id));
    const savedByTaskId = new Map<string, TaskStateRow>();
    if (taskIds.length) {
      const { data: stateRows, error: stateErr } = await supabase
        .from("tasks_state")
        .select("*")
        .in("task_id", taskIds);
      if (stateErr) throw new Error(`tasks_state select failed: ${stateErr.message}`);
      for (const row of (stateRows ?? []) as TaskStateRow[]) {
        savedByTaskId.set(row.task_id, row);
      }
    }

    const domain = env("WS_DOMAIN");
    const upserts: Array<Record<string, unknown>> = [];
    let checkedCount = 0;
    let notifiedCount = 0;

    for (const task of tasks) {
      checkedCount++;
      const taskId = String(task.id);
      const tags = task.tags ?? {};

      // Keep only tag entries that are status tags. Normally 0 or 1.
      const statusEntries = Object.entries(tags).filter(([tagId]) => statusTagIds.has(tagId));
      if (statusEntries.length > 1) {
        console.warn(
          `poll: task ${taskId} carries ${statusEntries.length} status tags; using first:`,
          JSON.stringify(statusEntries)
        );
      }
      const currentStatusId = statusEntries[0]?.[0] ?? null;
      const currentStatusName = statusEntries[0]?.[1] ?? null;

      const saved = savedByTaskId.get(taskId) ?? null;
      const savedStatusId = saved?.status_tag_id ?? null;

      // Three distinct cases:
      // 1. No prior tasks_state row, task is older than the threshold — this
      //    is just the first time OUR polling has seen a pre-existing task.
      //    Record a silent baseline, never notify.
      // 2. No prior row, task is younger than the threshold — it was just
      //    created. If it already carries a status tag, announce it.
      // 3. A prior row exists (even with a null status) — any difference from
      //    the current status, including a status being cleared entirely
      //    (current -> null, rendered "(без статусу)"), is a real change.
      let caseType: string;
      let shouldNotify = false;
      let notifyKind: "changed" | "new_status" | null = null;

      if (saved == null) {
        const addedAt = parseWsDate(task.date_added);
        const ageMinutes = addedAt ? (Date.now() - addedAt.getTime()) / 60000 : Infinity;
        const isNewTask = ageMinutes <= NEW_TASK_THRESHOLD_MINUTES;

        if (!isNewTask) {
          caseType = "baseline_recorded_existing_task";
        } else if (currentStatusId != null) {
          caseType = "new_task_with_status";
          shouldNotify = true;
          notifyKind = "new_status";
        } else {
          caseType = "new_task_no_status";
        }
      } else if (currentStatusId !== savedStatusId) {
        caseType = "existing_task_change";
        shouldNotify = true;
        notifyKind = "changed";
      } else {
        caseType = "existing_task_unchanged";
      }

      let notified = false;
      let skippedReason: string | null = shouldNotify ? null : caseType;

      if (shouldNotify) {
        const emp = findEmployee(task.user_to?.id);
        if (!emp) {
          skippedReason = "responsible_not_linked";
        } else if (!emp.notify_status_change) {
          skippedReason = "category_disabled";
        } else if (!emp.telegram_chat_id) {
          skippedReason = "no_telegram_chat_id";
        } else {
          const url = `https://${domain}${task.page}`;
          const message =
            notifyKind === "new_status"
              ? `🔄 У задачі «${task.name}» встановлено статус «${currentStatusName}»\n🔗 ${url}`
              : `🔄 У задачі «${task.name}» статус змінено: «${saved?.status_tag_name ?? "(без статусу)"}» → «${
                  currentStatusName ?? "(без статусу)"
                }»\n🔗 ${url}`;
          await sendMessage(emp.telegram_chat_id, message);
          notified = true;
          notifiedCount++;
        }
      }

      // Always refresh stored state (baseline for the next poll).
      upserts.push({
        task_id: taskId,
        project_id: task.project?.id != null ? String(task.project.id) : null,
        name: task.name,
        user_to_id: task.user_to?.id != null ? String(task.user_to.id) : null,
        user_to_email: task.user_to?.email ?? null,
        status: task.status ?? null,
        status_tag_id: currentStatusId,
        status_tag_name: currentStatusName,
        updated_at: new Date().toISOString(),
      });

      // Per-task structured diagnostics — mirrors the webhook event trace so
      // both flows read the same way in Vercel Logs.
      console.log(
        "poll task trace:",
        JSON.stringify({
          taskId,
          taskName: task.name,
          responsibleId: task.user_to?.id != null ? String(task.user_to.id) : null,
          savedStatusId,
          savedStatusName: saved?.status_tag_name ?? null,
          currentStatusId,
          currentStatusName,
          caseType,
          notified,
          skippedReason,
        })
      );
    }

    // One batched upsert for the whole pass (task_id is the conflict target).
    if (upserts.length) {
      const { error: upErr } = await supabase.from("tasks_state").upsert(upserts);
      if (upErr) console.error("poll: tasks_state batch upsert failed:", upErr.message);
    }

    res.status(200).json({
      status: "OK",
      totalActive: allTasks.length,
      candidates: tasks.length,
      checked: checkedCount,
      notified: notifiedCount,
      truncated,
    });
  } catch (e) {
    console.error("poll-status-changes error:", e);
    res.status(500).json({ status: "error", message: e instanceof Error ? e.message : String(e) });
  }
}
