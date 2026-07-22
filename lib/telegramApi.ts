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

// Sends a message with an inline keyboard (reply_markup.inline_keyboard).
export async function sendMessageWithMarkup(
  chatId: number,
  text: string,
  replyMarkup: object
): Promise<void> {
  try {
    await callTelegram("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      reply_markup: replyMarkup,
    });
  } catch (e) {
    console.error(`sendMessageWithMarkup to chat ${chatId} failed:`, e);
  }
}

// Must be called for every callback_query — otherwise the button keeps
// spinning in the user's Telegram client until it times out.
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string
): Promise<void> {
  try {
    await callTelegram("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
      show_alert: false,
    });
  } catch (e) {
    console.error("answerCallbackQuery failed:", e);
  }
}

// Swaps out the inline keyboard on an existing message (no text change).
export async function editMessageReplyMarkup(
  chatId: number,
  messageId: number,
  replyMarkup: object
): Promise<void> {
  try {
    await callTelegram("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    });
  } catch (e) {
    console.error("editMessageReplyMarkup failed:", e);
  }
}

export function setWebhook(url: string): Promise<unknown> {
  return callTelegram("setWebhook", { url });
}
