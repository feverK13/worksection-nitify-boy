# Worksection → Telegram Notifier

Serverless-сервіс (Vercel + Supabase), який приймає webhook-події з Worksection,
фільтрує їх і миттєво надсилає в Telegram лише у трьох випадках:

1. Вас згадали (@) у задачі або коментарі.
2. Вас призначили відповідальним за задачу (або зняли цей статус).
3. Будь-яка дія у задачі, де ви поточний відповідальний (крім ваших власних дій).

Повна специфікація: `worksection-notifier-spec.md`.

## Структура

```
api/worksection-webhook.ts   # приймає події Worksection
api/telegram-webhook.ts      # приймає Update від Telegram (команди бота)
lib/worksectionClient.ts     # Worksection admin API (MD5-hash auth, retry/backoff)
lib/supabaseClient.ts        # supabase-js із service_role ключем
lib/mentionParser.ts         # розпізнавання @згадок (2 стратегії)
lib/notifier.ts              # правила сповіщень + тексти повідомлень
lib/telegramApi.ts           # sendMessage / setWebhook
scripts/seed-employees.ts    # одноразово: get_users → employees + deep-links
scripts/register-worksection-webhook.ts
scripts/set-telegram-webhook.ts
```

## Чек-лист запуску

1. `npm install`, локально створити `.env` за зразком `.env.example`.
2. Задати ті самі змінні у Vercel → Project Settings → Environment Variables.
3. `git push` → деплой на Vercel → отримати `https://*.vercel.app` домен.
4. `npm run set-telegram-webhook -- https://your-app.vercel.app`
5. `npm run register-worksection-webhook -- https://your-app.vercel.app`
   (Basic Auth вмикається автоматично, якщо задані `WEBHOOK_HTTP_USER/PASS`).
6. `npm run seed` — заповнити `employees`, отримати персональні посилання.
7. Розіслати посилання команді (`https://t.me/{BOT}?start={code}`).
8. **Калібрування:** надіслати тестовий коментар з @згадкою, подивитись логи
   Vercel (і таблицю `webhook_log`), за потреби скоригувати
   `lib/mentionParser.ts` та список полів у `pick()` в
   `api/worksection-webhook.ts`.
9. Перевірити всі три сценарії на тестовій задачі.
10. Вимкнути `DEBUG_LOG_RAW_PAYLOADS`, перейти на бойові проєкти.

## Діагностика (опційно)

Таблиця для сирих payload'ів на етапі калібрування:

```sql
create table if not exists webhook_log (
    id bigint generated always as identity primary key,
    source text, -- 'worksection' | 'telegram'
    raw_payload jsonb,
    received_at timestamptz not null default now()
);
alter table webhook_log enable row level security;
```

Якщо таблиці немає — сервіс просто пише warning у лог і працює далі.
