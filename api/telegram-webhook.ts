import type { VercelRequest, VercelResponse } from "@vercel/node";
import { EmployeeRow, logWebhook, supabase } from "../lib/supabaseClient";
import { sendMessage } from "../lib/telegramApi";

interface TgMessage {
  chat: { id: number };
  from?: { id: number; username?: string };
  text?: string;
}

interface TgUpdate {
  message?: TgMessage;
  edited_message?: TgMessage;
}

const HELP_TEXT = `Я надсилаю сповіщення з Worksection:
• коли вас згадали (@) у задачі чи коментарі;
• коли вас призначили відповідальним або зняли цей статус;
• про дії в задачах, де ви відповідальний.

Команди:
/link email@company.com — прив'язати акаунт вручну
/whoami — статус підключення
/unlink — вимкнути сповіщення
/help — ця довідка`;

async function findByChatId(chatId: number): Promise<EmployeeRow | null> {
  const { data } = await supabase
    .from("employees")
    .select("*")
    .eq("telegram_chat_id", chatId)
    .maybeSingle();
  return (data as EmployeeRow | null) ?? null;
}

async function linkEmployee(
  emp: EmployeeRow,
  chatId: number,
  username: string | null
): Promise<void> {
  const { error } = await supabase
    .from("employees")
    .update({ telegram_chat_id: chatId, telegram_username: username, is_linked: true })
    .eq("id", emp.id);
  if (error) {
    console.error("linkEmployee update failed:", error.message);
    await sendMessage(chatId, "⚠️ Сталася помилка, спробуйте ще раз трохи згодом.");
    return;
  }
  await sendMessage(chatId, `✅ Вас підключено, ${emp.full_name ?? emp.email}!`);
}

async function handleCommand(message: TgMessage): Promise<void> {
  const chatId = message.chat.id;
  const username = message.from?.username ?? null;
  const [rawCommand, ...args] = (message.text ?? "").trim().split(/\s+/);
  const command = rawCommand.split("@")[0]; // handle /cmd@BotName form

  switch (command) {
    case "/start": {
      const code = args[0];
      if (!code) {
        await sendMessage(
          chatId,
          `Вітаю! Для підключення відкрийте своє персональне посилання або скористайтесь командою /link email@company.com\n\n${HELP_TEXT}`
        );
        return;
      }
      const { data } = await supabase
        .from("employees")
        .select("*")
        .eq("link_code", code)
        .maybeSingle();
      const emp = (data as EmployeeRow | null) ?? null;
      if (!emp) {
        await sendMessage(
          chatId,
          "❌ Посилання не розпізнано. Спробуйте /link email@company.com або зверніться до адміністратора."
        );
        return;
      }
      await linkEmployee(emp, chatId, username);
      return;
    }
    case "/link": {
      const email = (args[0] ?? "").toLowerCase();
      if (!email.includes("@")) {
        await sendMessage(chatId, "Вкажіть робочий email: /link email@company.com");
        return;
      }
      const { data } = await supabase
        .from("employees")
        .select("*")
        .ilike("email", email)
        .maybeSingle();
      const emp = (data as EmployeeRow | null) ?? null;
      if (!emp) {
        await sendMessage(
          chatId,
          `❌ Email ${email} не знайдено. Зверніться до адміністратора.`
        );
        return;
      }
      await linkEmployee(emp, chatId, username);
      return;
    }
    case "/whoami": {
      const emp = await findByChatId(chatId);
      await sendMessage(
        chatId,
        emp?.is_linked
          ? `✅ Ви підключені як ${emp.full_name ?? emp.email}\nСповіщення: увімкнено`
          : "❌ Ви не підключені. Скористайтесь персональним посиланням або /link email@company.com"
      );
      return;
    }
    case "/unlink": {
      const emp = await findByChatId(chatId);
      if (!emp || !emp.is_linked) {
        await sendMessage(chatId, "Ви й так не підключені.");
        return;
      }
      const { error } = await supabase
        .from("employees")
        .update({ is_linked: false })
        .eq("id", emp.id);
      if (error) {
        console.error("unlink update failed:", error.message);
        await sendMessage(chatId, "⚠️ Сталася помилка, спробуйте ще раз.");
        return;
      }
      await sendMessage(
        chatId,
        "➖ Сповіщення вимкнено. Щоб повернути — персональне посилання або /link."
      );
      return;
    }
    case "/help":
      await sendMessage(chatId, HELP_TEXT);
      return;
    default:
      await sendMessage(chatId, `Не розумію цю команду.\n\n${HELP_TEXT}`);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    const update = (
      typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {}
    ) as TgUpdate;
    if (process.env.DEBUG_LOG_RAW_PAYLOADS === "true") {
      console.log("telegram raw update:", JSON.stringify(update));
      await logWebhook("telegram", update);
    }
    const message = update.message ?? update.edited_message;
    if (message?.chat?.id && typeof message.text === "string") {
      await handleCommand(message);
    }
  } catch (e) {
    console.error("telegram-webhook error:", e);
  }
  res.status(200).json({ ok: true });
}
