-- 005: доступ сотрудников в админку, отзывы на разбор, договорённости.
--
-- Выполняется на существующей базе и ничего не ломает: у всех заведённых
-- менеджеров логина нет, а значит войти по-прежнему можно только владельческим
-- токеном (ADMIN_API_TOKEN). Доступ выдаётся по одному, из раздела «Сотрудники».

begin;

-- --- Доступ в админку ------------------------------------------------------

alter table employees
    add column if not exists login               varchar(64),
    add column if not exists password_hash       varchar(255),
    add column if not exists password_changed_at timestamptz,
    add column if not exists last_login_at       timestamptz,
    -- own — видит только свои смены; all — видит все и правит настройки.
    add column if not exists access_scope        varchar(16) not null default 'own';

-- Логин нечувствителен к регистру: «Anna» и «anna» — один человек, и второй
-- завестись не должен.
create unique index if not exists uq_employees_login
    on employees (lower(login))
    where login is not null;

-- --- Согласен / не согласен с разбором -------------------------------------

create table if not exists dialog_feedback (
    id                  uuid primary key default gen_random_uuid(),
    org_id              uuid not null references organizations(id),
    day_recording_id    uuid not null references day_recordings(id),
    dialog_id           uuid not null references dialogs(id),
    -- пусто — отзыв о разборе целиком, иначе о конкретной метрике (промпте)
    metric_id           uuid references analysis_metrics(id),
    author_key          varchar(64) not null,
    author_employee_id  uuid references employees(id),
    author_name         varchar(255) not null default '',
    subject_employee_id uuid references employees(id),
    subject_name        varchar(255) not null default '',
    agree               boolean not null,
    comment             text not null default '',
    created_at          timestamptz not null default now()
);

create index if not exists ix_feedback_day     on dialog_feedback (day_recording_id);
create index if not exists ix_feedback_dialog  on dialog_feedback (dialog_id);
create index if not exists ix_feedback_metric  on dialog_feedback (metric_id);
create index if not exists ix_feedback_subject on dialog_feedback (subject_employee_id);
create index if not exists ix_feedback_org     on dialog_feedback (org_id);
create index if not exists ix_feedback_author  on dialog_feedback (author_key);

-- Один голос одного человека на одну оценку: повторное нажатие меняет мнение,
-- а не добавляет второй голос. Индексов два, потому что NULL-и в уникальном
-- индексе Postgres считает разными значениями.
create unique index if not exists uq_feedback_dialog_overall
    on dialog_feedback (dialog_id, author_key) where metric_id is null;
create unique index if not exists uq_feedback_dialog_metric
    on dialog_feedback (dialog_id, metric_id, author_key) where metric_id is not null;

-- --- Договорённости по итогам разбора --------------------------------------

create table if not exists agreements (
    id                        uuid primary key default gen_random_uuid(),
    org_id                    uuid not null references organizations(id),
    employee_id               uuid references employees(id),
    employee_name             varchar(255) not null default '',
    day_recording_id          uuid not null references day_recordings(id),
    day_date                  date not null,
    dialog_id                 uuid references dialogs(id),
    dialog_start_s            double precision,
    text                      text not null,
    -- open | done | missed | cancelled
    status                    varchar(16) not null default 'open',
    created_by_employee_id    uuid references employees(id),
    created_by_name           varchar(255) not null default '',
    created_at                timestamptz not null default now(),
    resolved_at               timestamptz,
    resolved_by_name          varchar(255) not null default '',
    resolved_day_recording_id uuid references day_recordings(id),
    resolution_note           text not null default ''
);

create index if not exists ix_agreements_org      on agreements (org_id);
create index if not exists ix_agreements_day      on agreements (day_recording_id);
create index if not exists ix_agreements_date     on agreements (day_date);
create index if not exists ix_agreements_status   on agreements (status);
-- Главный запрос продукта: «что осталось незакрытым у этого менеджера
-- с прошлых смен» — он открывается при каждом заходе в карточку дня.
create index if not exists ix_agreements_employee_open
    on agreements (employee_id, status, day_date desc);

commit;
