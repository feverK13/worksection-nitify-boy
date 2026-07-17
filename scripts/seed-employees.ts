// One-off local script (spec §7): get_users → employees, prints personal
// deep links for the team. Run locally with `npm run seed`, never deployed.
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { getUsers } from "../lib/worksectionClient";
import { EmployeeRow, supabase } from "../lib/supabaseClient";
import { env } from "../lib/env";

async function main(): Promise<void> {
  const users = await getUsers();
  console.log(`Worksection returned ${users.length} users`);

  const { data: existingRows, error } = await supabase.from("employees").select("*");
  if (error) throw new Error(`employees select failed: ${error.message}`);
  const existingByEmail = new Map(
    ((existingRows ?? []) as EmployeeRow[]).map((e) => [e.email.toLowerCase(), e])
  );

  for (const user of users) {
    const email = user.email?.toLowerCase();
    if (!email) {
      console.warn(`Skipping user ${user.id} (${user.name ?? "?"}) — no email`);
      continue;
    }
    const fullName =
      user.name ?? [user.first_name, user.last_name].filter(Boolean).join(" ") ?? null;
    const existing = existingByEmail.get(email);
    if (existing) {
      // Re-running is safe: refresh WS data, keep link_code and Telegram binding.
      const { error: updError } = await supabase
        .from("employees")
        .update({ ws_user_id: String(user.id), full_name: fullName })
        .eq("id", existing.id);
      if (updError) throw new Error(`update ${email} failed: ${updError.message}`);
      console.log(`Updated ${email}`);
    } else {
      const { error: insError } = await supabase.from("employees").insert({
        email,
        ws_user_id: String(user.id),
        full_name: fullName,
        link_code: randomBytes(8).toString("hex"),
        is_linked: false,
      });
      if (insError) throw new Error(`insert ${email} failed: ${insError.message}`);
      console.log(`Inserted ${email}`);
    }
  }

  const { data: rows } = await supabase.from("employees").select("*").order("full_name");
  const bot = env("TELEGRAM_BOT_USERNAME");
  console.log("\nПерсональні посилання для розсилки:\n");
  for (const row of (rows ?? []) as EmployeeRow[]) {
    console.log(`${row.full_name ?? row.email} — https://t.me/${bot}?start=${row.link_code}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
