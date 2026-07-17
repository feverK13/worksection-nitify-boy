# Специфікація: Worksection → Telegram Notifier

## 1. Мета проєкту

Компанія використовує Worksection для трекінгу задач. Вбудовані сповіщення
працюють некоректно (десь забагато, десь замало). Потрібен окремий сервіс,
який приймає події з Worksection через webhook, фільтрує їх і надсилає
в Telegram **миттєво і лише** у трьох випадках:

1. Користувача згадали (@) у задачі або коментарі.
2. Користувача призначили відповідальним за задачу, або зняли з нього
   цей статус.
3. Відбулась будь-яка дія (новий коментар, редагування, закриття,
   повторне відкриття, видалення) у задачі, де користувач є **поточним**
   відповідальним — за винятком випадку, коли саме він і є автором дії
   (не сповіщати людину про її власні дії).

Дедублікація: якщо подія одночасно підпадає під кілька правил (наприклад,
згадка в коментарі до задачі, де людина ж і відповідальна) — надсилається
одне повідомлення, не два.

## 2. Технічний стек (узгоджено)

- **Хостинг:** Vercel (Hobby, безкоштовний), деплой через git push
- **Мова:** Node.js + TypeScript, serverless functions (`/api/*.ts`)
- **База даних:** Supabase (Postgres), доступ через `@supabase/supabase-js`
  з **secret (service_role) ключем**, тільки з боку серверних функцій.
  RLS увімкнено на обох таблицях без жодної policy — доступ ззовні
  (через publishable/anon ключ) повністю заблокований, це навмисно.
- **Telegram:** бот у **webhook-режимі** (не polling — Vercel не тримає
  довготривалих процесів). Telegram сам стукає на наш `/api/telegram-webhook`.

⚠️ Важливе архітектурне обмеження serverless: кожен виклик функції —
незалежний, нічого не зберігається в пам'яті між викликами. Тому:
- Немає "стартового" скрипта заповнення стану задач. Якщо задача ще не
  зустрічалась (немає рядка в `tasks_state`) — просто зберігаємо її
  поточний стан як baseline і **не** генеруємо подію "змінили відповідального"
  для цього першого разу (нема з чим порівнювати). Але правило 3
  (дія в задачі де я відповідальний) працює одразу, бо воно не залежить
  від попереднього стану.
- Rate limit Worksection API — 1 запит/сек. У serverless немає
  спільної пам'яті для лічильника між викликами, тож замість точного
  rate-limiter реалізувати retry з backoff при помилці "too many requests"
  (простий exponential backoff, 2-3 спроби). Для обсягу подій маленької
  команди це не має бути проблемою на практиці.

## 3. Worksection API — довідка

### 3.1 Автентифікація (admin token)

```
base_url = https://{WS_DOMAIN}/api/admin/v2/

hash = MD5(query_string + WS_ADMIN_API_KEY)
```

де `query_string` — це url-encoded рядок усіх параметрів запиту
(включно з `action`), **без** параметра `hash`, у тому вигляді, в якому
він піде в URL. `hash` додається окремим параметром в кінці.

Приклад (з офіційної документації):
```
query_params = 'action=get_tasks&id_project=26'
api_key = '7776461cd931e7b1c8e9632ff8e979ce'
hash = md5(query_params + api_key)
# => https://youraccount.worksection.com/api/admin/v2/?action=get_tasks&id_project=26&hash=...
```

Ліміти: **1 запит/секунду**, макс. 10 000 записів у відповіді,
GET-запити обмежені 8 KB.

### 3.2 Реєстрація webhook

```
GET /api/admin/v2/?action=add_webhook&url=<URL>&events=<events>&hash=<hash>
```

Параметр `events` — через кому, можливі значення:
```
post_task, update_task, close_task, reopen_task, delete_task,
post_comment, update_comment, delete_comment
```

Опційно: `projects=<id1,id2>` (обмежити конкретними проєктами),
`http_user` / `http_pass` (Basic Auth на вебхук-URL — **рекомендовано
увімкнути** для захисту ендпоїнта).

Вимога до нашого ендпоїнта: відповісти протягом 5 секунд статусом
`200` і тілом `{"status":"OK"}`, інакше подія вважається помилковою.

⚠️ **Точний формат тіла POST-запиту, який Worksection надсилає на наш
webhook, публічно не задокументований** (офіційна сторінка показує це
скріншотами, не текстом). План дій:
- Ендпоїнт має прийняти тіло і як JSON, і як `application/x-www-form-urlencoded`
  (пробувати обидва варіанти парсингу).
- З перших же реальних подій — **залогувати сирий payload повністю**
  (в консоль Vercel і за бажанням в окрему таблицю `webhook_log` в Supabase)
  і на основі цього зафіксувати реальну схему полів (ймовірно містить
  щось на кшталт `event`/`action`, `id_task` або `id_comment`, `id_project`).
- Це перший практичний крок після деплою — калібрування має відбутись
  до того, як покладатись на продакшн-логіку.

### 3.3 Задачі

```
GET ?action=get_task&id_task=<ID>&extra=text,html,subscribers
```

Ключові поля відповіді:
```json
{
  "id": "TASK_ID",
  "name": "TASK_NAME",
  "page": "/project/PROJECT_ID/TASK_ID/",
  "status": "active | done",
  "user_from": { "id": "...", "email": "...", "name": "..." },
  "user_to":   { "id": "...", "email": "...", "name": "..." },
  "project":   { "id": "...", "name": "...", "page": "..." },
  "text": "..."
}
```

`user_to` — це і є "відповідальний". Може бути відсутнім (executive
не призначений).

### 3.4 Коментарі

```
GET ?action=get_comments&id_task=<ID>
```

Повертає масив, кожен елемент:
```json
{
  "id": "COMMENT_ID",
  "text": "COMMENT_TEXT",
  "date_added": "...",
  "user_from": { "id": "...", "email": "...", "name": "..." }
}
```

Немає окремого параметра `extra=html` для коментарів (лише `extra=files`) —
отже формат `text` для згадок доведеться визначити емпірично (див. 3.2 і
розділ 5 про калібрування).

### 3.5 Список користувачів (для onboarding)

```
GET ?action=get_users
```

Повертає масив: `id`, `email`, `name`, `first_name`, `last_name`, `role`, і т.д.
Використовується один раз для заповнення таблиці `employees`.

## 4. Supabase — схема (вже створена)

```sql
create table if not exists employees (
    id bigint generated always as identity primary key,
    ws_user_id text,
    email text unique not null,
    full_name text,
    telegram_chat_id bigint,
    telegram_username text,
    link_code text unique,
    is_linked boolean not null default false,
    created_at timestamptz not null default now()
);

create table if not exists tasks_state (
    task_id text primary key,
    project_id text,
    name text,
    user_to_id text,
    user_to_email text,
    status text,
    updated_at timestamptz not null default now()
);

alter table employees enable row level security;
alter table tasks_state enable row level security;
-- RLS увімкнено навмисно без жодної policy: доступ лише через
-- service_role ключ з боку серверних функцій.
```

Рекомендація: додати ще одну таблицю для діагностики (не обов'язково,
але дуже допоможе на етапі калібрування):

```sql
create table if not exists webhook_log (
    id bigint generated always as identity primary key,
    source text, -- 'worksection' | 'telegram'
    raw_payload jsonb,
    received_at timestamptz not null default now()
);
alter table webhook_log enable row level security;
```

## 5. Розпізнавання згадок (@Ім'я) — потребує калібрування

Стратегія (закладена одразу як подвійна, бо точний формат невідомий):

1. **Через посилання на профіль** — якщо Worksection рендерить згадку як
   `<a href=".../profile/{ID}">`, шукати цей `{ID}` і зіставляти з
   `employees.ws_user_id`.
2. **Через текстовий патерн** — резервно шукати `@Ім'я` або `@Ім'я_Прізвище`
   у сирому тексті і зіставляти з `employees.full_name` (нечітке
   співставлення: збіг першого слова імені, підрядок тощо).

Обидві стратегії застосовувати одночасно, об'єднуючи знайдені збіги.
Якщо жодна не спрацювала на реальних даних — залогувати сирий текст і
скоригувати регулярні вирази вручну (це очікувано і має бути закладено
як перший практичний тест після деплою, не як гіпотетичний edge case).

## 6. Логіка сповіщень (детально)

Вхід: подія `event` + дані задачі (`task`) і, якщо є, коментаря (`comment`).

```
actor_id = comment ? comment.user_from.id : task.user_from.id  // хто вчинив дію

notified_employee_ids = {}  // щоб не дублювати повідомлення одній людині

# --- Правило 2: зміна відповідального ---
if event in (post_task, update_task):
    prev_state = tasks_state[task.id]  # може бути відсутнім
    new_user_to_id = task.user_to?.id
    old_user_to_id = prev_state?.user_to_id

    if prev_state exists and new_user_to_id != old_user_to_id:
        if new_user_to_id:
            notify("assigned", new_user_to_id, task)
            notified_employee_ids.add(new_user_to_id)
        if old_user_to_id and old_user_to_id != new_user_to_id:
            notify("unassigned", old_user_to_id, task)
            notified_employee_ids.add(old_user_to_id)

# --- Правило 1: згадки ---
mention_source = comment ? comment.text : task.text
mentioned = resolve_mentions(mention_source, all_employees)
for emp in mentioned:
    if emp.id not in notified_employee_ids and emp.id != actor_id:
        notify("mention", emp.id, task, comment)
        notified_employee_ids.add(emp.id)

# --- Правило 3: дія в задачі, де я відповідальний ---
current_responsible_id = task.user_to?.id
if current_responsible_id
   and current_responsible_id not in notified_employee_ids
   and current_responsible_id != actor_id:
    notify("task_activity", current_responsible_id, task, comment, event)

# --- Зберегти новий стан задачі (завжди, в кінці) ---
save_task_state(task)
```

Формат повідомлень — українською, з посиланням на задачу
(`https://{WS_DOMAIN}{task.page}`), приклади:

- Згадка: `🔔 Вас згадали у задачі «{name}»\n👤 {actor_name}\n🔗 {link}`
- Призначення: `✅ Вас призначено відповідальним за «{name}»\n🔗 {link}`
- Зняття: `➖ З вас знято статус відповідального за «{name}»\n🔗 {link}`
- Активність: `📌 {подія_укр} у задачі «{name}», де ви відповідальний\n👤 {actor_name}\n🔗 {link}`

## 7. Telegram-бот

Режим: **webhook**, ендпоїнт `/api/telegram-webhook`.
Після першого деплою виконати один раз:
```
POST https://api.telegram.org/bot{TOKEN}/setWebhook
  ?url=https://{VERCEL_DOMAIN}/api/telegram-webhook
```

### Онбординг співробітників (максимально простий, без набору email)

1. Одноразовий скрипт (`scripts/seed-employees.ts`, запускається локально
   один раз, **не** деплоїться як Vercel function) викликає `get_users`
   і заповнює таблицю `employees` (email, full_name, ws_user_id,
   згенерований унікальний `link_code`, `is_linked=false`).
2. Для кожного співробітника формується персональне посилання:
   `https://t.me/{BOT_USERNAME}?start={link_code}`.
3. Ці посилання розсилаються один раз (наприклад, одним повідомленням
   у корпоративний чат: "Ім'я — посилання").
4. Співробітник тапає посилання → Telegram надсилає `/start {link_code}`
   на наш webhook → бот знаходить рядок у `employees` за `link_code`,
   записує `telegram_chat_id`, `telegram_username`, ставить `is_linked=true`,
   відповідає `✅ Вас підключено, {full_name}!`.

### Команди

| Команда | Дія |
|---|---|
| `/start {code}` | Автоматична прив'язка за deep-link кодом (основний спосіб) |
| `/link email@company.com` | Резервний спосіб прив'язки вручну (звірити з `employees.email`) |
| `/whoami` | Показати поточний статус підключення |
| `/unlink` | Від'єднати сповіщення (`is_linked=false`) |
| `/help` | Коротка довідка |

## 8. Структура проєкту (пропозиція)

```
worksection-notifier/
├── api/
│   ├── worksection-webhook.ts   # приймає події Worksection
│   └── telegram-webhook.ts      # приймає Update від Telegram
├── lib/
│   ├── worksectionClient.ts     # обгортка над Worksection API (розділ 3)
│   ├── supabaseClient.ts        # ініціалізація supabase-js (service_role)
│   ├── mentionParser.ts         # розпізнавання згадок (розділ 5)
│   ├── notifier.ts              # логіка сповіщень (розділ 6) + формування текстів
│   └── telegramApi.ts           # sendMessage, setWebhook helpers
├── scripts/
│   └── seed-employees.ts        # одноразовий запуск локально (get_users → employees)
├── package.json
├── tsconfig.json
├── vercel.json                  # (за потреби — конфігурація функцій)
└── .env.example
```

## 9. Змінні середовища

```
WS_DOMAIN=youraccount.worksection.com
WS_ADMIN_API_KEY=...

TELEGRAM_BOT_TOKEN=...
TELEGRAM_BOT_USERNAME=adp_ws_notify_bot

SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...        # service_role, НЕ publishable

WEBHOOK_HTTP_USER=...                     # Basic Auth на /api/worksection-webhook
WEBHOOK_HTTP_PASS=...

DEBUG_LOG_RAW_PAYLOADS=true               # вимкнути після калібрування
```

Усі значення заповнюються в Vercel → Project Settings → Environment Variables
(ніколи не комітяться в git).

## 10. Що вже зроблено (стан на момент передачі)

- ✅ Supabase-проєкт створено, таблиці `employees` і `tasks_state` створені,
  RLS увімкнено.
- ✅ Telegram-бот створений через @BotFather, токен отримано, базове
  оформлення (опис, команди) налаштоване.
- ⬜ Vercel-проєкт (репозиторій, package.json, функції) — ще не створено.
- ⬜ Webhook у Worksection — ще не зареєстрований (потрібен готовий
  Vercel-домен).
- ⬜ Калібрування формату згадок — не виконано (потрібні реальні дані).

## 11. Чек-лист запуску після написання коду

1. `git push` → деплой на Vercel → отримати постійний `https://*.vercel.app` домен.
2. Виконати `setWebhook` для Telegram-бота (розділ 7).
3. Зареєструвати webhook у Worksection на `/api/worksection-webhook`
   (розділ 3.2), увімкнути Basic Auth.
4. Запустити `scripts/seed-employees.ts` — заповнити `employees`.
5. Розіслати персональні deep-link посилання команді.
6. Надіслати тестовий коментар з @згадкою → перевірити логи → за
   потреби скоригувати `mentionParser.ts`.
7. Перевірити всі три сценарії на тестовій задачі/проєкті.
8. Прибрати `DEBUG_LOG_RAW_PAYLOADS`, перейти на бойові проєкти.
