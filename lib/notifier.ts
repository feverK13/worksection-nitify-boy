import { getTask, WsTask } from "./worksectionClient";
import { EmployeeRow, supabase, TaskStateRow } from "./supabaseClient";
import { resolveMentions } from "./mentionParser";
import { sendMessage } from "./telegramApi";
import { env } from "./env";

// --- Real Worksection webhook event shape (from production payloads) ---
// The webhook body is an ARRAY of these; each is one event.
export interface WsWebhookUser {
  id: number | string;
  email?: string;
  name?: string;
}

export interface WsWebhookEvent {
  action?: string; // "post" | "update" | "close" | "reopen" | "delete" | ...
  object?: {
    type?: string; // "comment" | "task"
    id?: number | string; // comment id OR task id
    page?: string; // "/task/{TASK_ID}/" — always points at the task
  };
  date_added?: string;
  user_from?: WsWebhookUser; // the actor
  new?: {
    text?: string;
    user_to?: WsWebhookUser;
    priority?: string;
    files?: unknown[];
    custom_fields?: Record<string, unknown>;
    [key: string]: unknown;
  };
  old?: {
    user_to?: WsWebhookUser;
    [key: string]: unknown;
  };
}

// "Anyone / unassigned" — Worksection's sentinel responsible user.
const ANYONE_ID = "2";

function extractTaskId(page: string | undefined, objectId: number | string | undefined): string | null {
  const match = /\/task\/(\d+)\//.exec(page ?? "");
  if (match) return match[1];
  // Fallback: for task events object.id IS the task id.
  return objectId != null ? String(objectId) : null;
}

function eventLabel(action: string, objType: string): string {
  if (action === "post" && objType === "comment") return "Новий коментар";
  if (action === "update" && objType === "task") return "Задачу оновлено";
  if (action === "close" && objType === "task") return "Задачу закрито";
  if (action === "reopen" && objType === "task") return "Задачу повторно відкрито";
  if (action === "delete" && objType === "comment") return "Коментар видалено";
  return `${action} ${objType}`.trim();
}

// Processes a single webhook event and fires the (deduplicated) notifications.
// `employees` is the list of linked employees, fetched once per batch.
export async function processWebhookEvent(
  event: WsWebhookEvent,
  employees: EmployeeRow[]
): Promise<void> {
  const action = event.action ?? "";
  const objType = event.object?.type ?? "";
  const taskId = extractTaskId(event.object?.page, event.object?.id);
  if (!taskId) {
    console.warn("No task id in event — skipping:", JSON.stringify(event));
    return;
  }

  const actor = event.user_from ?? null;
  const actorId = actor?.id != null ? String(actor.id) : null;
  const actorName = actor?.name ?? "Невідомий користувач";
  const rawText = typeof event.new?.text === "string" ? event.new.text : "";

  const domain = env("WS_DOMAIN");
  const page = event.object?.page ?? `/task/${taskId}/`;
  const link = `https://${domain}${page}`;

  const byWsId = new Map(
    employees.filter((e) => e.ws_user_id).map((e) => [String(e.ws_user_id), e])
  );
  const findEmployee = (id: number | string | null | undefined): EmployeeRow | null =>
    id != null ? byWsId.get(String(id)) ?? null : null;

  // One person gets at most one message per event (dedup by ws_user_id).
  const notified = new Set<string>();

  const deliver = async (emp: EmployeeRow, text: string) => {
    if (!emp.telegram_chat_id) {
      console.log(`Employee ${emp.email} has no telegram_chat_id — skipping notify`);
      return;
    }
    await sendMessage(emp.telegram_chat_id, text);
  };

  // --- Memoized lookups (avoid duplicate DB/API calls within one event) ---
  let taskStateLoaded = false;
  let taskState: TaskStateRow | null = null;
  const loadTaskState = async (): Promise<TaskStateRow | null> => {
    if (!taskStateLoaded) {
      const { data } = await supabase
        .from("tasks_state")
        .select("*")
        .eq("task_id", taskId)
        .maybeSingle();
      taskState = (data as TaskStateRow | null) ?? null;
      taskStateLoaded = true;
    }
    return taskState;
  };

  let apiTaskLoaded = false;
  let apiTask: WsTask | null = null;
  const loadApiTask = async (): Promise<WsTask | null> => {
    if (!apiTaskLoaded) {
      apiTaskLoaded = true;
      try {
        apiTask = await getTask(taskId);
      } catch (e) {
        console.warn(`get_task ${taskId} failed:`, e);
        apiTask = null;
      }
    }
    return apiTask;
  };

  const resolveTaskName = async (): Promise<string> => {
    const ts = await loadTaskState();
    if (ts?.name) return ts.name;
    const t = await loadApiTask();
    if (t?.name) return t.name;
    return `#${taskId}`;
  };

  const upsertTaskState = async (row: Partial<TaskStateRow>): Promise<void> => {
    const { error } = await supabase.from("tasks_state").upsert({
      task_id: taskId,
      ...row,
      updated_at: new Date().toISOString(),
    });
    if (error) console.error("tasks_state upsert failed:", error.message);
  };

  // --- Rule 2: responsible (user_to) changed ---
  if (action === "update" && objType === "task" && event.new?.user_to) {
    const newTo = event.new.user_to;
    const oldTo = event.old?.user_to ?? null;
    if (oldTo && String(newTo.id) !== String(oldTo.id)) {
      const taskName = await resolveTaskName();
      // Newly assigned
      if (String(newTo.id) !== ANYONE_ID) {
        const emp = findEmployee(newTo.id);
        if (emp && emp.ws_user_id && emp.ws_user_id !== actorId) {
          await deliver(
            emp,
            `✅ Вас призначено відповідальним за задачу «${taskName}»\n👤 ${actorName}\n🔗 ${link}`
          );
          notified.add(emp.ws_user_id);
        }
      }
      // Unassigned
      if (String(oldTo.id) !== ANYONE_ID) {
        const emp = findEmployee(oldTo.id);
        if (emp && emp.ws_user_id && emp.ws_user_id !== actorId && !notified.has(emp.ws_user_id)) {
          await deliver(
            emp,
            `➖ З вас знято відповідальність за задачу «${taskName}»\n👤 ${actorName}\n🔗 ${link}`
          );
          notified.add(emp.ws_user_id);
        }
      }
    }
  }

  // --- Rule 1: mentions (full_name substring in new.text) ---
  if (rawText.trim()) {
    const mentionLabel = objType === "comment" ? "у коментарі до задачі" : "у задачі";
    const snippet = rawText.trim().slice(0, 100);
    const ellipsis = rawText.trim().length > 100 ? "…" : "";
    for (const emp of resolveMentions(rawText, employees)) {
      const wsId = emp.ws_user_id;
      if (!wsId || notified.has(wsId) || wsId === actorId) continue;
      const taskName = await resolveTaskName();
      await deliver(
        emp,
        `🔔 Вас згадали ${mentionLabel} «${taskName}»\n👤 ${actorName}\n💬 ${snippet}${ellipsis}\n🔗 ${link}`
      );
      notified.add(wsId);
    }
  }

  // --- Rule 3: activity in a task where I am the current responsible ---
  let currentResponsible: WsWebhookUser | null = null;
  if (event.new?.user_to && String(event.new.user_to.id) !== ANYONE_ID) {
    currentResponsible = event.new.user_to;
  } else {
    const ts = await loadTaskState();
    if (ts?.user_to_id && ts.user_to_id !== ANYONE_ID) {
      currentResponsible = { id: ts.user_to_id };
    } else {
      const t = await loadApiTask();
      if (t?.user_to?.id && String(t.user_to.id) !== ANYONE_ID) {
        currentResponsible = t.user_to;
      }
      // Cache the API result for next time.
      if (t) {
        await upsertTaskState({
          name: t.name ?? null,
          user_to_id: t.user_to?.id != null ? String(t.user_to.id) : null,
          user_to_email: t.user_to?.email ?? null,
          status: t.status ?? null,
          project_id: t.project?.id ?? null,
        });
      }
    }
  }

  if (currentResponsible) {
    const emp = findEmployee(currentResponsible.id);
    if (emp && emp.ws_user_id && !notified.has(emp.ws_user_id) && emp.ws_user_id !== actorId) {
      const taskName = await resolveTaskName();
      await deliver(
        emp,
        `📌 ${eventLabel(action, objType)} у задачі «${taskName}», де ви відповідальний\n👤 ${actorName}\n🔗 ${link}`
      );
      notified.add(emp.ws_user_id);
    }
  }

  // --- Update tasks_state after a task event that carries user_to ---
  // Omit `name`: upsert only writes provided columns, so leaving it out
  // preserves any name already stored (the webhook never carries it).
  if (objType === "task" && event.new?.user_to) {
    const newTo = event.new.user_to;
    await upsertTaskState({
      user_to_id: newTo.id != null ? String(newTo.id) : null,
      user_to_email: newTo.email ?? null,
    });
  }
}
