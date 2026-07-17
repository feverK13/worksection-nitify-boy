// One-off local script (spec §3.2): registers the Worksection webhook on the
// deployed Vercel domain, with Basic Auth if WEBHOOK_HTTP_USER/PASS are set.
// Usage: npm run register-worksection-webhook -- https://your-app.vercel.app
import "dotenv/config";
import { addWebhook } from "../lib/worksectionClient";

const ALL_EVENTS = [
  "post_task",
  "update_task",
  "close_task",
  "reopen_task",
  "delete_task",
  "post_comment",
  "update_comment",
  "delete_comment",
];

async function main(): Promise<void> {
  const base = process.argv[2];
  if (!base) {
    console.error("Usage: npm run register-worksection-webhook -- https://your-app.vercel.app");
    process.exit(1);
  }
  const url = `${base.replace(/\/+$/, "")}/api/worksection-webhook`;
  const result = await addWebhook(
    url,
    ALL_EVENTS,
    process.env.WEBHOOK_HTTP_USER,
    process.env.WEBHOOK_HTTP_PASS
  );
  console.log(`Webhook registered: ${url}`);
  if (result != null) console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
