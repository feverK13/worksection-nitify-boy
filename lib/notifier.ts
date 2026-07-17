import type { WsComment, WsTask } from "./worksectionClient";
import { EmployeeRow, supabase, TaskStateRow } from "./supabaseClient";
import { resolveMentions } from "./mentionParser";
import { sendMessage } from "./telegramApi";
import { env } from "./env";

export const KNOWN_EVENTS = [
  "post_task",
  "update_task",
  "close_task",
  "reopen_task",
  "delete_task",
  "post_comment",
  "update_comment",
  "delete_comment",
] as const;

export type WsEvent = (typeof KNOWN_EVENTS)[number];

const EVENT_LABELS: Record<WsEvent, string> = {
  post_task: "Створено задачу",
  update_task: "Оновлено задачу",
  close_task: "Закрито задачу",
  reopen_task: "Знову відкрито задачу",
  delete_task: "Видалено задачу",
  post_comment: "Новий коментар",
  update_comment: "Відредаговано коментар",
  delete_comment: "Видалено коментар",
};

function taskLink(task: WsTask): string {
  const domain = env("WS_DOMAIN");
  return task.page ? `https://${domain}${task.page}` : `https://${domain}`;
}

export async function processEvent(
  event: WsEvent,
  task: WsTask,
  comment: WsComment | null
): Promise<void> {
  const { data: employeeRows, error: empError } = await supabase.from("employees").select("*");
  if (empError) throw new Error(`employees select failed: ${empError.message}`);
  const employees = (employeeRows ?? []) as EmployeeRow[];
  const byWsId = new Map(
    employees.filter((e) => e.ws_user_id).map((e) => [e.ws_user_id as string, e])
  );

  const actor = comment?.user_from ?? task.user_from ?? null;
  const actorId = actor?.id ?? null;
  const actorName = actor?.name ?? "Невідомий користувач";

  const { data: prevRow } = await supabase
    .from("tasks_state")
    .select("*")
    .eq("task_id", task.id)
    .maybeSingle();
  const prev = (prevRow as TaskStateRow | null) ?? null;

  // Dedup: one person gets at most one message per event even if several rules match.
  const notified = new Set<string>();
  const link = taskLink(task);

  const deliver = async (wsUserId: string, text: string) => {
    const emp = byWsId.get(wsUserId);
    if (!emp) {
      console.log(`No employee row for ws_user_id=${wsUserId} — skipping notify`);
      return;
    }
    if (!emp.is_linked || !emp.telegram_chat_id) {
      console.log(`Employee ${emp.email} is not linked to Telegram — skipping notify`);
      return;
    }
    await sendMessage(emp.telegram_chat_id, text);
  };

  // --- Rule 2: responsible (user_to) changed ---
  // If the task has never been seen (no prev state) this is just a baseline
  // save — nothing to compare against, no notification (spec §2).
  if (event === "post_task" || event === "update_task") {
    const newUserToId = task.user_to?.id ?? null;
    const oldUserToId = prev?.user_to_id ?? null;
    if (prev && newUserToId !== oldUserToId) {
      if (newUserToId) {
        await deliver(
          newUserToId,
          `✅ Вас призначено відповідальним за «${task.name}»\n🔗 ${link}`
        );
        notified.add(newUserToId);
      }
      if (oldUserToId && oldUserToId !== newUserToId) {
        await deliver(
          oldUserToId,
          `➖ З вас знято статус відповідального за «${task.name}»\n🔗 ${link}`
        );
        notified.add(oldUserToId);
      }
    }
  }

  // --- Rule 1: mentions ---
  const mentionSource = comment ? comment.text : task.text;
  for (const emp of resolveMentions(mentionSource, employees)) {
    const wsId = emp.ws_user_id;
    if (!wsId || notified.has(wsId) || wsId === actorId) continue;
    await deliver(
      wsId,
      `🔔 Вас згадали у задачі «${task.name}»\n👤 ${actorName}\n🔗 ${link}`
    );
    notified.add(wsId);
  }

  // --- Rule 3: any activity in a task where I am the current responsible ---
  const responsibleId = task.user_to?.id ?? null;
  if (responsibleId && !notified.has(responsibleId) && responsibleId !== actorId) {
    await deliver(
      responsibleId,
      `📌 ${EVENT_LABELS[event]} у задачі «${task.name}», де ви відповідальний\n👤 ${actorName}\n🔗 ${link}`
    );
    notified.add(responsibleId);
  }

  // --- Save the new task state (always, at the end) ---
  if (event === "delete_task") {
    const { error } = await supabase.from("tasks_state").delete().eq("task_id", task.id);
    if (error) console.error("tasks_state delete failed:", error.message);
  } else {
    const { error } = await supabase.from("tasks_state").upsert({
      task_id: task.id,
      project_id: task.project?.id ?? prev?.project_id ?? null,
      name: task.name ?? null,
      user_to_id: task.user_to?.id ?? null,
      user_to_email: task.user_to?.email ?? null,
      status: task.status ?? null,
      updated_at: new Date().toISOString(),
    });
    if (error) console.error("tasks_state upsert failed:", error.message);
  }
}
