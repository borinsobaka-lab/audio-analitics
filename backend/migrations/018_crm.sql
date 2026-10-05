-- 018: третий продукт админки — «CRM»: ежедневный разбор переписок и
-- движения сделок.
--
-- 1. employees.crm_access — право в продукте: own (видит разборы по своим
--    сделкам) | all (видит всё и настраивает: критерии, промпт, интеграцию).
--    Тем, у кого уже есть «все смены» в аналитике, сразу ставится all, чтобы
--    администраторы увидели новый продукт без отдельной выдачи прав.
-- 2. crm_settings — настройки продукта одной строкой JSON на организацию:
--    промпты, модель, правила воронки, ключ интеграции, расписание разбора,
--    соответствие менеджеров CRM сотрудникам.
-- 3. crm_deals / crm_messages / crm_events — данные CRM, какими их прислала
--    интеграция: сделки, сообщения переписки и события (смена этапа,
--    заметка, задача). Сообщения и события без внешнего id не теряют
--    уникальности: дубли отсекаются по (сделка, время, направление, текст).
-- 4. crm_criteria — критерии оценки, которые владелец заводит полями: по ним
--    ИИ ставит оценку каждой сделке дня, и по ним же строится статистика.
-- 5. crm_runs — один разбор дня; crm_reviews — разбор одной сделки за день;
--    crm_review_scores — оценка по одному критерию.
--
-- Безопасно для повторного запуска.

begin;

alter table employees
    add column if not exists crm_access varchar(16) not null default 'own';

update employees
   set crm_access = 'all'
 where access_scope = 'all' and crm_access = 'own';

create table if not exists crm_settings (
    org_id uuid primary key references organizations(id),
    data jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now(),
    updated_by varchar(255) not null default ''
);

create table if not exists crm_deals (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null references organizations(id),
    external_id varchar(64) not null,
    title varchar(255) not null default '',
    contact_name varchar(255) not null default '',
    contact_phone varchar(64) not null default '',
    pipeline varchar(120) not null default '',
    stage varchar(120) not null default '',
    -- open | won | lost
    status varchar(16) not null default 'open',
    source varchar(120) not null default '',
    manager_key varchar(64) not null default '',
    manager_name varchar(255) not null default '',
    employee_id uuid references employees(id),
    url varchar(512) not null default '',
    budget double precision,
    created_at_crm timestamptz,
    updated_at_crm timestamptz,
    last_activity_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint uq_crm_deal_external unique (org_id, external_id)
);
create index if not exists ix_crm_deals_org_activity on crm_deals (org_id, last_activity_at);
create index if not exists ix_crm_deals_org_manager on crm_deals (org_id, manager_key);

create table if not exists crm_messages (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null references organizations(id),
    deal_id uuid not null references crm_deals(id) on delete cascade,
    external_id varchar(64),
    -- in — от клиента, out — от администратора
    direction varchar(8) not null,
    channel varchar(40) not null default '',
    author_key varchar(64) not null default '',
    author_name varchar(255) not null default '',
    text text not null default '',
    at timestamptz not null,
    created_at timestamptz not null default now()
);
create unique index if not exists uq_crm_messages_external
    on crm_messages (org_id, external_id) where external_id is not null;
create index if not exists ix_crm_messages_deal_at on crm_messages (deal_id, at);
create index if not exists ix_crm_messages_org_at on crm_messages (org_id, at);

create table if not exists crm_events (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null references organizations(id),
    deal_id uuid not null references crm_deals(id) on delete cascade,
    external_id varchar(64),
    -- stage_change | status_change | note | task | task_done | field_change | call
    kind varchar(32) not null,
    from_value varchar(255) not null default '',
    to_value varchar(255) not null default '',
    text text not null default '',
    author_key varchar(64) not null default '',
    author_name varchar(255) not null default '',
    at timestamptz not null,
    created_at timestamptz not null default now()
);
create unique index if not exists uq_crm_events_external
    on crm_events (org_id, external_id) where external_id is not null;
create index if not exists ix_crm_events_deal_at on crm_events (deal_id, at);
create index if not exists ix_crm_events_org_at on crm_events (org_id, at);

create table if not exists crm_criteria (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null references organizations(id),
    name varchar(255) not null,
    prompt text not null default '',
    scale_max integer not null default 10,
    active boolean not null default true,
    position integer not null default 0,
    created_at timestamptz not null default now()
);
create index if not exists ix_crm_criteria_org on crm_criteria (org_id);

create table if not exists crm_runs (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null references organizations(id),
    date date not null,
    -- queued | processing | done | error
    status varchar(16) not null default 'queued',
    status_detail text not null default '',
    status_changed_at timestamptz not null default now(),
    -- manual | schedule
    trigger varchar(16) not null default 'manual',
    deals_total integer not null default 0,
    reviews_done integer not null default 0,
    problems_count integer not null default 0,
    llm_input_tokens integer not null default 0,
    llm_output_tokens integer not null default 0,
    llm_calls integer not null default 0,
    cost_usd double precision,
    summary_json jsonb,
    created_at timestamptz not null default now(),
    finished_at timestamptz,
    constraint uq_crm_run_date unique (org_id, date)
);

create table if not exists crm_reviews (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null references organizations(id),
    run_id uuid not null references crm_runs(id) on delete cascade,
    deal_id uuid not null references crm_deals(id) on delete cascade,
    date date not null,
    employee_id uuid references employees(id),
    manager_key varchar(64) not null default '',
    manager_name varchar(255) not null default '',
    category varchar(40) not null default 'other',
    -- ok | warning | critical
    severity varchar(16) not null default 'ok',
    problem boolean not null default false,
    summary text not null default '',
    problems_json jsonb not null default '[]'::jsonb,
    good_json jsonb not null default '[]'::jsonb,
    recommendations_json jsonb not null default '[]'::jsonb,
    scripts_json jsonb not null default '{}'::jsonb,
    pipeline_json jsonb not null default '{}'::jsonb,
    messages_in integer not null default 0,
    messages_out integer not null default 0,
    events_count integer not null default 0,
    first_reply_minutes double precision,
    max_reply_minutes double precision,
    unanswered boolean not null default false,
    created_at timestamptz not null default now(),
    constraint uq_crm_review_run_deal unique (run_id, deal_id)
);
create index if not exists ix_crm_reviews_org_date on crm_reviews (org_id, date);
create index if not exists ix_crm_reviews_employee_date on crm_reviews (employee_id, date);
create index if not exists ix_crm_reviews_deal on crm_reviews (deal_id);

create table if not exists crm_review_scores (
    id uuid primary key default gen_random_uuid(),
    review_id uuid not null references crm_reviews(id) on delete cascade,
    criterion_id uuid not null references crm_criteria(id) on delete cascade,
    applicable boolean not null default false,
    score integer,
    comment text not null default '',
    constraint uq_crm_score unique (review_id, criterion_id)
);
create index if not exists ix_crm_review_scores_criterion on crm_review_scores (criterion_id);

commit;
