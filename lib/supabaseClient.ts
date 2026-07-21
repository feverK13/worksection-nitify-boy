import { createClient } from "@supabase/supabase-js";
import { env } from "./env";

export interface EmployeeRow {
  id: number;
  ws_user_id: string | null;
  email: string;
  full_name: string | null;
  telegram_chat_id: number | null;
  telegram_username: string | null;
  link_code: string | null;
  is_linked: boolean;
}

export interface TaskStateRow {
  task_id: string;
  project_id: string | null;
  name: string | null;
  user_to_id: string | null;
  user_to_email: string | null;
  status: string | null;
  // Current "status" tag (a tag from a group of type `status`), tracked by the
  // polling endpoint — this is NOT delivered via webhooks. See api/poll-status-changes.ts.
  status_tag_id: string | null;
  status_tag_name: string | null;
}

// service_role key, server-side only; RLS on the tables has no policies,
// so this client is the only way in.
export const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Best-effort diagnostics; the webhook_log table is optional.
export async function logWebhook(
  source: "worksection" | "telegram",
  rawPayload: unknown
): Promise<void> {
  const { error } = await supabase
    .from("webhook_log")
    .insert({ source, raw_payload: rawPayload });
  if (error) {
    console.warn(`webhook_log insert failed (table may not exist): ${error.message}`);
  }
}
