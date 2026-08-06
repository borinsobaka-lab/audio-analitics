# Инструкция для агента: настройка инфраструктуры Audio Analytics

Ты — агент, выполняющий настройку через браузер Chrome в аккаунтах владельца.
Выполняй шаги строго по порядку. Репозиторий проекта:
`github.com/borinsobaka-lab/audio-analitics`, ветка
`claude/audio-recording-sales-analysis-x6tit4`.

## ⛔ Правила безопасности (прочитай перед началом)

1. **Ничего не удалять и не изменять в существующих ресурсах.** На сервере в
   Coolify уже работает другой продукт; в Supabase уже есть другой проект.
   Ты только СОЗДАЁШЬ новые ресурсы. Не трогай чужие проекты, приложения,
   базы, DNS-записи, бакеты.
2. Всё новое называй с префиксом/именем `audio-analytics`, чтобы было
   отличимо.
3. Секреты (пароли, API-ключи, токены) записывай в защищённое место
   (менеджер паролей / приватная заметка). Не вставляй их в поисковые строки,
   публичные документы или чаты. В финальном отчёте перечисли ГДЕ сохранены
   значения, но не сами значения.
4. Если какой-то шаг не получается или интерфейс выглядит иначе — остановись
   на этом шаге и напиши, что видишь. Не импровизируй с настройками, которых
   нет в инструкции.
5. По ходу работы веди «Блокнот результатов» — список значений, которые
   понадобятся на следующих шагах (помечены как 📝).

## Что должно быть на руках у владельца (спросить, если нет доступа)

- Доступ в аккаунты: Hetzner-сервер с Coolify, Supabase, Cloudflare, GitHub.
- Аккаунты Anthropic и ElevenLabs (если нет — по ходу инструкции есть шаг
  регистрации; потребуется банковская карта).
- Домен, уже добавленный в Cloudflare (какой поддомен использовать для API —
  см. Шаг 5). Если домена нет — остановись и спроси владельца.

---

## Шаг 1. API-ключ Anthropic (LLM-анализ)

1. Открой https://console.anthropic.com и войди (или зарегистрируйся).
2. Меню слева → **API Keys** → **Create Key**. Имя: `audio-analytics`.
3. 📝 Сохрани ключ (начинается с `sk-ant-`) — он показывается один раз.
4. Проверь биллинг: **Settings → Billing**. Если баланса нет — пополни
   минимум на $5 (Buy credits) или уточни у владельца.

## Шаг 2. API-ключ ElevenLabs (распознавание речи)

1. Открой https://elevenlabs.io и войди (или зарегистрируйся).
2. Клик по аватару/имени внизу слева → **API Keys** (или
   https://elevenlabs.io/app/settings/api-keys) → **Create API Key**.
   Имя: `audio-analytics`. Права: достаточно Speech-to-Text (если есть выбор
   скоупов — включи Speech to Text; иначе оставь по умолчанию).
3. 📝 Сохрани ключ.
4. Тариф: бесплатного плана не хватит на часы аудио. Открой
   **Subscription** и оформи план **Starter** (~$5/мес) или согласуй с
   владельцем. Без этого шага транскрипция упрётся в лимит.

## Шаг 3. Supabase — новый проект с базой данных

⚠️ В аккаунте уже есть другой проект — его НЕ трогать. Создаём соседний.

1. Открой https://supabase.com/dashboard → кнопка **New project**
   (в той же организации, где живёт существующий проект).
2. Параметры:
   - Name: `audio-analytics`
   - Database Password: нажми **Generate a password**. 📝 Сохрани пароль.
   - Region: **Central EU (Frankfurt)** (ближе к Hetzner).
   - План: Free подойдёт для старта.
3. Дождись создания проекта (1–2 минуты).
4. **Миграция схемы.** Слева → **SQL Editor** → **New query**. Открой в
   соседней вкладке
   `https://github.com/borinsobaka-lab/audio-analitics/blob/claude/audio-recording-sales-analysis-x6tit4/backend/migrations/001_initial.sql`,
   нажми Raw, скопируй ВЕСЬ текст, вставь в SQL Editor и нажми **Run**.
   Ожидаемый результат: «Success. No rows returned».
5. **Строка подключения.** Вверху страницы проекта нажми **Connect**.
   В открывшемся окне найди раздел **Session pooler** (НЕ «Transaction
   pooler» и НЕ «Direct connection» — они не подойдут: transaction-режим
   ломает воркер, а direct доступен только по IPv6).
   Скопируй строку вида:
   `postgresql://postgres.XXXX:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`
6. Подставь в неё пароль из п. 2 вместо `[YOUR-PASSWORD]` и замени префикс
   `postgresql://` на `postgresql+asyncpg://`.
   📝 Сохрани итоговую строку как `DATABASE_URL`.

## Шаг 4. Cloudflare R2 — хранилище аудио

1. Открой https://dash.cloudflare.com → в левом меню **R2 Object Storage**.
   Если R2 ещё не активирован — нажми активировать (потребует привязанную
   карту; free-тир 10 ГБ, при наших объёмах платежи копеечные).
2. **Create bucket**:
   - Name: `audio-analytics`
   - Location: **Automatic** (или Specify location → **Eastern Europe (EEUR)**).
   - Storage class: Standard. → **Create bucket**.
3. **Правило автоудаления (60 дней).** Открой бакет → вкладка **Settings** →
   раздел **Object lifecycle rules** → **Add rule**:
   - Rule name: `delete-old-audio`
   - Prefix: оставить пустым (всё содержимое)
   - Action: **Delete uploaded objects** через **60** дней. Сохрани.
4. **API-токен.** Вернись на главную R2 → справа **Manage R2 API Tokens**
   (или `API` → `Manage API tokens`) → **Create API Token**:
   - Name: `audio-analytics-backend`
   - Permissions: **Object Read & Write**
   - Specify bucket(s): только `audio-analytics` (не «All buckets»!)
   - TTL: Forever. → Create.
5. 📝 Со страницы результата сохрани три значения:
   - **Access Key ID** → `S3_ACCESS_KEY_ID`
   - **Secret Access Key** → `S3_SECRET_ACCESS_KEY`
   - Endpoint вида `https://<account_id>.r2.cloudflarestorage.com`
     (показан там же как «Use jurisdiction-specific endpoints…» / S3 API) →
     `S3_ENDPOINT_URL`

## Шаг 5. Cloudflare DNS — поддомен для API

1. В Cloudflare открой зону домена владельца (**Websites** → домен).
2. **DNS → Records → Add record**:
   - Type: **A**
   - Name: `api-audio` (получится `api-audio.<домен>`; если владелец назвал
     другой поддомен — используй его)
   - IPv4 address: IP Hetzner-сервера (владелец знает; также виден в Coolify:
     Servers → сервер → IP)
   - **Proxy status: DNS only (серое облако)** — это важно, иначе Coolify не
     сможет выпустить TLS-сертификат.
   - TTL: Auto. → Save.
3. 📝 Запиши итоговый адрес API: `https://api-audio.<домен>` → `API_URL`.
4. Существующие DNS-записи не менять.

## Шаг 6. Coolify — деплой бэкенда

⚠️ В Coolify уже развёрнут другой продукт. Его проект/ресурсы не открывать
и не менять. Работаем только внутри нового проекта.

1. Открой панель Coolify (адрес и логин у владельца).
2. **Доступ к GitHub.** Проверь **Sources**: если GitHub-аккаунт
   `borinsobaka-lab` уже подключён (например, для текущего продукта) —
   пропусти. Иначе: **Sources → Add → GitHub App**, следуй мастеру
   (Register/Install GitHub App), при установке дай приложению доступ к
   репозиторию `audio-analitics`.
3. **Projects → Add** (или «+ New»): имя `audio-analytics`. Открой его
   (environment `production`).
4. **+ New Resource → Docker Compose** (в разделе Git/приватный репозиторий
   через GitHub App):
   - Repository: `borinsobaka-lab/audio-analitics`
   - Branch: `claude/audio-recording-sales-analysis-x6tit4`
   - Docker Compose Location: `/docker-compose.yml`
   - Сохрани (Continue/Load compose).
5. Coolify покажет сервисы `redis`, `api`, `worker`.
6. **Домен для API.** В настройках сервиса `api` найди поле **Domains** и
   впиши: `https://api-audio.<домен>` (адрес из Шага 5). Порт назначения,
   если спрашивается, — `8000`.
7. **Environment Variables** ресурса (вкладка Environment Variables) —
   добавь по одной (значения из Блокнота результатов; режим Build Variable
   нигде включать не нужно):

   | Имя | Значение |
   |---|---|
   | `ENVIRONMENT` | `production` |
   | `API_BASE_URL` | `https://api-audio.<домен>` |
   | `DATABASE_URL` | строка из Шага 3.6 |
   | `S3_ENDPOINT_URL` | из Шага 4.5 |
   | `S3_ACCESS_KEY_ID` | из Шага 4.5 |
   | `S3_SECRET_ACCESS_KEY` | из Шага 4.5 |
   | `S3_BUCKET` | `audio-analytics` |
   | `ELEVENLABS_API_KEY` | из Шага 2 |
   | `ANTHROPIC_API_KEY` | из Шага 1 |
   | `ADMIN_API_TOKEN` | сгенерируй в Шаге 8 (пока не добавляй) |
   | `DEVICE_API_KEYS` | заполним в Шаге 8 (пока не добавляй) |
   | `CORS_ORIGINS` | заполним в Шаге 9 (пока не добавляй) |

8. Нажми **Deploy** и дождись успешной сборки (первая сборка 5–10 минут).
   Статус всех трёх сервисов должен стать Running/Healthy.
9. Проверка: открой в браузере `https://api-audio.<домен>/health` —
   должно вернуться `{"status":"ok"}`. Если 502/timeout — подожди минуту
   (выпускается сертификат) и обнови.

## Шаг 7. Инициализация базы (seed)

1. В Coolify открой ресурс → сервис **api** → вкладка **Terminal**
   (Execute Command / Connect). Открой шелл контейнера `api`.
2. Выполни:
   ```
   python -m cli.seed --org "Stretching Tbilisi" --location "Студия 1"
   ```
   (названия можно уточнить у владельца).
3. 📝 Из вывода сохрани `location_id` (UUID из строки
   `Created location: ...` / финальной подсказки).
4. Там же сгенерируй два секрета:
   ```
   python -c "import secrets; print('DEVICE KEY:', secrets.token_urlsafe(32)); print('ADMIN TOKEN:', secrets.token_urlsafe(32))"
   ```
   📝 Сохрани оба значения.

## Шаг 8. Дозаполнение переменных и перезапуск

1. Вернись в Environment Variables ресурса в Coolify и добавь:
   - `DEVICE_API_KEYS` = `<DEVICE KEY из Шага 7>:<location_id из Шага 7>`
     (формат строго `ключ:uuid`, без пробелов)
   - `ADMIN_API_TOKEN` = `<ADMIN TOKEN из Шага 7>`
2. Нажми **Redeploy** (или Restart) ресурса, дождись Running.
3. Проверка: открой `https://api-audio.<домен>/api/prompts` — должен
   вернуться ответ `401`/`Missing bearer token` (это правильно: API закрыт).

## Шаг 9. Cloudflare Pages — дашборд

1. В Cloudflare: **Workers & Pages → Create → Pages →
   Connect to Git** (потребуется авторизация GitHub, дай доступ к
   репозиторию `audio-analitics`).
2. Выбери репозиторий `borinsobaka-lab/audio-analitics`. Настройки сборки:
   - Project name: `audio-analytics-dashboard`
   - Production branch: `claude/audio-recording-sales-analysis-x6tit4`
   - Framework preset: **None** (или Vite, если есть)
   - Build command: `npm run build`
   - Build output directory: `dist`
   - **Root directory (Advanced): `dashboard`** — обязательно!
   - Environment variables (Build): `VITE_API_URL` = `https://api-audio.<домен>`
3. **Save and Deploy**, дождись зелёного деплоя.
4. 📝 Запиши выданный адрес вида `https://audio-analytics-dashboard.pages.dev`
   (или настрой красивый поддомен через Custom domains — по желанию владельца).
5. Вернись в Coolify → Environment Variables → добавь:
   - `CORS_ORIGINS` = адрес дашборда из п. 4 (без слэша на конце,
     например `https://audio-analytics-dashboard.pages.dev`)
6. **Redeploy** ресурса в Coolify ещё раз.

## Шаг 10. Финальная проверка

1. Открой дашборд (адрес из Шага 9).
2. В левом нижнем углу в поле **«Токен доступа»** вставь `ADMIN_API_TOKEN`
   и нажми «Сохранить» (страница перезагрузится).
3. Открой страницу **«Промпты анализа»** — должны отобразиться 3 промпта
   (Этап 1 — Сегментация, Этап 2 — Разбор, Итог дня).
4. Открой **«Скрипт продаж»** — должен отобразиться базовый скрипт с
   6 этапами.
5. Страница «Отчёты по дням» пуста — это нормально: записей ещё не было.

## Финальный отчёт владельцу

Составь список:
- ✅/❌ по каждому шагу;
- адрес API и адрес дашборда;
- где сохранены: пароль БД Supabase, `DATABASE_URL`, ключи R2, ключи
  Anthropic/ElevenLabs, `DEVICE_API_KEYS`, `ADMIN_API_TOKEN`, `location_id`;
- какие тарифы/платежи были подключены (Anthropic credits, ElevenLabs
  Starter, R2);
- проблемы, если были.

Значения `API_URL`, `DEVICE KEY` и `ADMIN_API_TOKEN` понадобятся владельцу
для настройки десктоп-приложения и дашборда.
