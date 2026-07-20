import type { VercelRequest, VercelResponse } from "@vercel/node";
import { logWebhook, supabase, EmployeeRow } from "../lib/supabaseClient";
import { processWebhookEvent, WsWebhookEvent } from "../lib/notifier";

function checkBasicAuth(req: VercelRequest): boolean {
  const user = process.env.WEBHOOK_HTTP_USER;
  const pass = process.env.WEBHOOK_HTTP_PASS;
  if (!user && !pass) return true;
  const expected =
    "Basic " + Buffer.from(`${user ?? ""}:${pass ?? ""}`).toString("base64");
  return (req.headers.authorization ?? "") === expected;
}

// Real Worksection payload is a JSON ARRAY of events. It may arrive already
// parsed (application/json), as a raw string, or as a single object; normalize
// all of those into an array of events.
function parseEvents(req: VercelRequest): WsWebhookEvent[] {
  let body = req.body as unknown;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return [];
    }
  }
  if (Array.isArray(body)) return body as WsWebhookEvent[];
  if (body && typeof body === "object") return [body as WsWebhookEvent];
  return [];
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!checkBasicAuth(req)) {
    res.status(401).json({ status: "unauthorized" });
    return;
  }

  // Vercel serverless has no background jobs: everything must finish BEFORE we
  // return. The per-event work is kept light (webhook already carries user_to,
  // API calls only on fallback) to stay under Worksection's 5s response window.
  try {
    if (process.env.DEBUG_LOG_RAW_PAYLOADS === "true") {
      console.log(
        "worksection raw payload:",
        JSON.stringify({ contentType: req.headers["content-type"], body: req.body })
      );
      await logWebhook("worksection", req.body);
    }

    const events = parseEvents(req);
    if (events.length === 0) {
      console.warn("worksection webhook: empty/unparseable body");
    } else {
      const { data: empRows, error } = await supabase
        .from("employees")
        .select("*")
        .eq("is_linked", true);
      if (error) throw new Error(`employees select failed: ${error.message}`);
      const employees = (empRows ?? []) as EmployeeRow[];

      for (const event of events) {
        try {
          await processWebhookEvent(event, employees);
        } catch (e) {
          console.error("worksection event processing failed:", e, JSON.stringify(event));
        }
      }
    }
  } catch (e) {
    console.error("worksection-webhook error:", e);
  }

  // Worksection expects HTTP 200 with {"status":"OK"} within 5 seconds;
  // internal failures are logged above but must not fail the webhook.
  res.status(200).json({ status: "OK" });
}
