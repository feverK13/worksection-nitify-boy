import { env } from "./env";

async function callTelegram(method: string, payload: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(
    `https://api.telegram.org/bot${env("TELEGRAM_BOT_TOKEN")}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; description?: string; result?: unknown }
    | null;
  if (!res.ok || !body?.ok) {
    throw new Error(`Telegram ${method} failed: ${body?.description ?? `HTTP ${res.status}`}`);
  }
  return body.result;
}

export async function sendMessage(chatId: number, text: string): Promise<void> {
  try {
    await callTelegram("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    });
  } catch (e) {
    // One failed delivery must not break processing of the rest of the event.
    console.error(`sendMessage to chat ${chatId} failed:`, e);
  }
}

export function setWebhook(url: string): Promise<unknown> {
  return callTelegram("setWebhook", { url });
}
