// One-off local script (spec §7): points the Telegram bot webhook at the
// deployed Vercel domain.
// Usage: npm run set-telegram-webhook -- https://your-app.vercel.app
import "dotenv/config";
import { setWebhook } from "../lib/telegramApi";

async function main(): Promise<void> {
  const base = process.argv[2];
  if (!base) {
    console.error("Usage: npm run set-telegram-webhook -- https://your-app.vercel.app");
    process.exit(1);
  }
  const url = `${base.replace(/\/+$/, "")}/api/telegram-webhook`;
  const result = await setWebhook(url);
  console.log(`Telegram webhook set: ${url}`);
  if (result != null) console.log(JSON.stringify(result));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
