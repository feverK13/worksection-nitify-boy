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
  if (action === "post" && objType === "task") return "Задачу створено";
  if (action === "update" && objType === "task") return "Задачу оновлено";
  if (action === "close" && objType === "task") return "Задачу закрито";
  if (action === "reopen" && objType === "task") return "Задачу повторно відкрито";
  if (action === "delete" && objType === "comment") return "Коментар видалено";
  return `${action} ${objType}`.trim();
}

// Comment/mention text shown under 💬 — trimmed and capped at ~200 chars.
// Always returns whatever text is present (even just an attached file's name),
// so the 💬 line is never dropped for a real comment.
function buildSnippet(text: string): string {
  const trimmed = (text ?? "").trim();
  const snippet = trimmed.slice(0, 200);
  return trimmed.length > 200 ? `${snippet}...` : snippet;
}

// --- Change 2: detailed "task updated" diff (update_task, user_to unchanged) ---
const FIELD_LABELS: Record<string, string> = {
  priority: "Пріоритет",
  name: "Назва задачі",
  text: "Опис",
  date_to: "Термін виконання",
  date_end: "Термін виконання",
  // додавати за потреби, якщо зустрінуться нові поля в реальних payload
};

const EXCLUDED_KEYS = new Set(["user_to"]); // обробляється окремо, Правило 2

function formatRawValue(v: any): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function describeTaskChanges(newObj: any, oldObj: any): string[] {
  const changes: string[] = [];

  for (const key of Object.keys(newObj || {})) {
    if (EXCLUDED_KEYS.has(key)) continue;

    const newVal = newObj[key];
    const oldVal = oldObj?.[key];

    if (key === "custom_fields") {
      // Вкладена структура: { fieldId: { id, name, type, value, text } }
      for (const fieldId of Object.keys(newVal || {})) {
        const newField = newVal[fieldId];
        const oldField = oldVal?.[fieldId];
        const newText = newField?.text ?? formatRawValue(newField?.value);
        const oldText = oldField?.text ?? formatRawValue(oldField?.value);
        if (newText === oldText) continue;
        const label = newField?.name || `Поле ${fieldId}`;
        changes.push(`${label}: ${oldText || "—"} → ${newText || "—"}`);
      }
      continue;
    }

    if (JSON.stringify(newVal) === JSON.stringify(oldVal)) continue;

    const label = FIELD_LABELS[key] || key;
    changes.push(`${label}: ${formatRawValue(oldVal)} → ${formatRawValue(newVal)}`);
  }

  return changes;
}

// A single-line, human-scannable summary of every decision taken for one event.
// Populated as processWebhookEvent runs and returned to the caller, which logs
// it once (under DEBUG_LOG_RAW_PAYLOADS) so the whole event reads at a glance.
export interface EventTrace {
  action: string;
  objectType: string;
  objectId: string | number | null;
  taskId: string | null;
  actorId: string | null;
  actorName: string;
  currentResponsibleId: string | null;
  currentResponsibleFrom: "payload" | "tasks_state" | "api_fallback" | null;
  mentionedEmployeeIds: string[];
  assignmentChange: { from: string | null; to: string | null } | null;
  notifiedEmployeeIds: string[];
  skippedReasons: string[];
}

// Processes a single webhook event and fires the (deduplicated) notifications.
// `employees` is the list of linked employees, fetched once per batch.
// Returns a per-event trace describing every routing decision made.
export async function processWebhookEvent(
  event: WsWebhookEvent,
  employees: EmployeeRow[]
): Promise<EventTrace> {
  const action = event.action ?? "";
  const objType = event.object?.type ?? "";
  const taskId = extractTaskId(event.object?.page, event.object?.id);

  const trace: EventTrace = {
    action,
    objectType: objType,
    objectId: event.object?.id ?? null,
    taskId,
    actorId: null,
    actorName: "Невідомий користувач",
    currentResponsibleId: null,
    currentResponsibleFrom: null,
    mentionedEmployeeIds: [],
    assignmentChange: null,
    notifiedEmployeeIds: [],
    skippedReasons: [],
  };
  // Push a reason a given recipient was NOT notified (for Vercel Logs triage).
  const skip = (reason: string) => trace.skippedReasons.push(reason);

  if (!taskId) {
    console.warn("No task id in event — skipping:", JSON.stringify(event));
    trace.skippedReasons.push("no_task_id");
    return trace;
  }

  const actor = event.user_from ?? null;
  const actorId = actor?.id != null ? String(actor.id) : null;
  const actorName = actor?.name ?? "Невідомий користувач";
  trace.actorId = actorId;
  trace.actorName = actorName;
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
      trace.assignmentChange = { from: String(oldTo.id), to: String(newTo.id) };
      const taskName = await resolveTaskName();
      // Newly assigned
      if (String(newTo.id) !== ANYONE_ID) {
        const emp = findEmployee(newTo.id);
        if (!emp || !emp.ws_user_id) {
          skip("assign_target_not_linked");
        } else if (emp.ws_user_id === actorId) {
          skip("actor_is_recipient");
        } else if (!emp.notify_assignment) {
          skip("category_disabled");
        } else {
          await deliver(
            emp,
            `✅ У задачі «${taskName}» вас призначено відповідальним\n👤 ${actorName}\n🔗 ${link}`
          );
          notified.add(emp.ws_user_id);
        }
      }
      // Unassigned
      if (String(oldTo.id) !== ANYONE_ID) {
        const emp = findEmployee(oldTo.id);
        if (!emp || !emp.ws_user_id) {
          skip("unassign_target_not_linked");
        } else if (emp.ws_user_id === actorId) {
          skip("actor_is_recipient");
        } else if (notified.has(emp.ws_user_id)) {
          skip("already_notified");
        } else if (!emp.notify_assignment) {
          skip("category_disabled");
        } else {
          await deliver(
            emp,
            `➖ У задачі «${taskName}» з вас знято статус відповідального\n👤 ${actorName}\n🔗 ${link}`
          );
          notified.add(emp.ws_user_id);
        }
      }
    }
  }

  // --- Rule 2 (post): responsible set on a freshly created task ---
  // A newly created task can carry user_to without any `old` — the person was
  // assigned the moment the task was created. Treat it as an assignment too.
  if (action === "post" && objType === "task" && event.new?.user_to) {
    const newTo = event.new.user_to;
    if (String(newTo.id) !== ANYONE_ID) {
      trace.assignmentChange = { from: null, to: String(newTo.id) };
      const emp = findEmployee(newTo.id);
      if (!emp || !emp.ws_user_id) {
        skip("assign_target_not_linked");
      } else if (emp.ws_user_id === actorId) {
        skip("actor_is_recipient");
      } else if (notified.has(emp.ws_user_id)) {
        skip("already_notified");
      } else if (!emp.notify_assignment) {
        skip("category_disabled");
      } else {
        const taskName = await resolveTaskName();
        await deliver(
          emp,
          `✅ У задачі «${taskName}» вас призначено відповідальним\n👤 ${actorName}\n🔗 ${link}`
        );
        notified.add(emp.ws_user_id);
      }
    }
  }

  // --- Rule 1: mentions (full_name substring in new.text) ---
  if (rawText.trim()) {
    const mentionSuffix = objType === "comment" ? " у коментарі" : "";
    const snippet = buildSnippet(rawText);
    for (const emp of resolveMentions(rawText, employees)) {
      const wsId = emp.ws_user_id;
      if (wsId) trace.mentionedEmployeeIds.push(wsId);
      if (!wsId) {
        skip("mentioned_employee_not_linked");
        continue;
      }
      if (wsId === actorId) {
        skip("actor_is_recipient");
        continue;
      }
      if (notified.has(wsId)) {
        skip("already_notified");
        continue;
      }
      if (!emp.notify_mentions) {
        skip("category_disabled");
        continue;
      }
      const taskName = await resolveTaskName();
      await deliver(
        emp,
        `🔔 У задачі «${taskName}» вас згадали${mentionSuffix}\n👤 ${actorName}\n💬 ${snippet}\n🔗 ${link}`
      );
      notified.add(wsId);
    }
  }

  // --- Rule 3: activity in a task where I am the current responsible ---
  let currentResponsible: WsWebhookUser | null = null;
  if (event.new?.user_to && String(event.new.user_to.id) !== ANYONE_ID) {
    currentResponsible = event.new.user_to;
    trace.currentResponsibleFrom = "payload";
  } else {
    const ts = await loadTaskState();
    if (ts?.user_to_id && ts.user_to_id !== ANYONE_ID) {
      currentResponsible = { id: ts.user_to_id };
      trace.currentResponsibleFrom = "tasks_state";
    } else {
      const t = await loadApiTask();
      if (t?.user_to?.id && String(t.user_to.id) !== ANYONE_ID) {
        currentResponsible = t.user_to;
        trace.currentResponsibleFrom = "api_fallback";
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
    trace.currentResponsibleId = String(currentResponsible.id);
    const emp = findEmployee(currentResponsible.id);
    if (!emp || !emp.ws_user_id) {
      skip("responsible_not_linked");
    } else if (emp.ws_user_id === actorId) {
      skip("actor_is_recipient");
    } else if (notified.has(emp.ws_user_id)) {
      skip("already_notified");
    } else if (!emp.notify_task_activity) {
      skip("category_disabled");
    } else {
      const taskName = await resolveTaskName();
      // Build the message based on WHAT the event is. Comments and plain
      // task updates get bespoke formats; everything else keeps the 📌 label.
      const userToChanged = !!(
        event.new?.user_to &&
        event.old?.user_to &&
        String(event.new.user_to.id) !== String(event.old.user_to.id)
      );

      let message: string | null = null;
      if (objType === "comment") {
        // Change 1: unified comment format (no mention → "new comment in
        // your task"). 💬 always shown — even if the text is just a filename.
        const snippet = buildSnippet(rawText);
        message =
          `🔔 У задачі «${taskName}», де ви відповідальний, новий коментар\n` +
          `👤 ${actorName}\n💬 ${snippet}\n🔗 ${link}`;
      } else if (action === "update" && objType === "task" && !userToChanged) {
        // Change 2: detailed diff. This fires EXCLUSIVELY for update_task
        // without a user_to change — assignment (user_to) is Rule 2's job and
        // is excluded here both by !userToChanged and by EXCLUDED_KEYS.
        const changes = describeTaskChanges(event.new, event.old);
        if (changes.length === 0) {
          // Worksection sometimes emits an update with no tracked field
          // actually changing — don't notify at all in that case.
          skip("no_meaningful_changes");
        } else {
          message =
            `🔧 У задачі «${taskName}», де ви відповідальний, відбулись зміни:\n` +
            `${changes.map((c) => `• ${c}`).join("\n")}\n` +
            `👤 ${actorName}\n🔗 ${link}`;
        }
      } else if (action === "close" && objType === "task") {
        message =
          `🔒 У задачі «${taskName}», де ви відповідальний, задачу закрито\n` +
          `👤 ${actorName}\n🔗 ${link}`;
      } else if (action === "reopen" && objType === "task") {
        message =
          `🔓 У задачі «${taskName}», де ви відповідальний, задачу повторно відкрито\n` +
          `👤 ${actorName}\n🔗 ${link}`;
      } else if (action === "delete" && objType === "task") {
        message =
          `🗑 У задачі «${taskName}», де ви відповідальний, задачу видалено\n` +
          `👤 ${actorName}\n🔗 ${link}`;
      } else {
        // task created / comment deleted / anything else — generic fallback.
        const label = eventLabel(action, objType);
        const lowerLabel = label.charAt(0).toLowerCase() + label.slice(1);
        message =
          `📌 У задачі «${taskName}», де ви відповідальний, ${lowerLabel}\n` +
          `👤 ${actorName}\n🔗 ${link}`;
      }

      if (message) {
        await deliver(emp, message);
        notified.add(emp.ws_user_id);
      }
    }
  } else {
    skip("no_responsible");
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

  trace.notifiedEmployeeIds = [...notified];
  return trace;
}
