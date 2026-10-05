-- Initial schema. Run against Supabase Postgres (SQL editor or psql).
-- Multi-tenancy: org_id on every business table. RLS policies below assume
-- the API connects with the service role; enable stricter per-user policies
-- when dashboard users get org membership (see comment at the bottom).

create extension if not exists "pgcrypto";

create table if not exists organizations (
    id uuid primary key default gen_random_uuid(),
    name varchar(255) not null,
    created_at timestamptz not null default now()
);

create table if not exists locations (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null references organizations(id),
    name varchar(255) not null,
    address varchar(512) not null default '',
    timezone varchar(64) not null default 'Asia/Tbilisi'
);
create index if not exists ix_locations_org on locations(org_id);

create table if not exists employees (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null references organizations(id),
    location_id uuid not null references locations(id),
    full_name varchar(255) not null,
    role varchar(64) not null default 'manager',
    voiceprint_ref varchar(512),
    active boolean not null default true,
    created_at timestamptz not null default now()
);
create index if not exists ix_employees_org on employees(org_id);

create table if not exists day_recordings (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null references organizations(id),
    location_id uuid not null references locations(id),
    employee_id uuid references employees(id),
    date date not null,
    status varchar(32) not null default 'recording',
    status_detail text not null default '',
    raw_audio_uri varchar(512),
    total_duration_s double precision,
    speech_duration_s double precision,
    created_at timestamptz not null default now()
);
create index if not exists ix_day_recordings_org on day_recordings(org_id);
create index if not exists ix_day_recordings_date on day_recordings(date);

create table if not exists segments (
    id uuid primary key default gen_random_uuid(),
    day_recording_id uuid not null references day_recordings(id),
    idx integer not null,
    audio_uri varchar(512) not null,
    start_s double precision,
    end_s double precision,
    uploaded_at timestamptz not null default now(),
    constraint uq_segment_idx unique (day_recording_id, idx)
);

create table if not exists transcripts (
    id uuid primary key default gen_random_uuid(),
    day_recording_id uuid not null references day_recordings(id),
    asr_provider varchar(64) not null default 'elevenlabs',
    language_hint varchar(32) not null default 'auto',
    raw_json_uri varchar(512),
    text text not null default '',
    created_at timestamptz not null default now()
);
create index if not exists ix_transcripts_day on transcripts(day_recording_id);

create table if not exists dialogs (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null references organizations(id),
    day_recording_id uuid not null references day_recordings(id),
    start_s double precision not null,
    end_s double precision not null,
    type varchar(32) not null,
    outcome varchar(32),
    brief text not null default '',
    manager_employee_id uuid references employees(id),
    effectiveness_score double precision,
    upsell_count integer not null default 0,
    analysis_json jsonb
);
create index if not exists ix_dialogs_day on dialogs(day_recording_id);
create index if not exists ix_dialogs_org on dialogs(org_id);

create table if not exists dialog_turns (
    id uuid primary key default gen_random_uuid(),
    dialog_id uuid not null references dialogs(id),
    speaker_label varchar(64) not null,
    is_manager boolean,
    start_s double precision not null,
    end_s double precision not null,
    text text not null
);
create index if not exists ix_dialog_turns_dialog on dialog_turns(dialog_id);

create table if not exists script_templates (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null references organizations(id),
    version integer not null default 1,
    name varchar(255) not null default 'Скрипт продаж',
    stages_json jsonb not null default '[]',
    body text not null default '',
    active boolean not null default true,
    created_at timestamptz not null default now()
);
create index if not exists ix_script_templates_org on script_templates(org_id);

create table if not exists prompt_templates (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null references organizations(id),
    key varchar(64) not null,
    name varchar(255) not null,
    description text not null default '',
    content text not null,
    model varchar(64),
    version integer not null default 1,
    active boolean not null default true,
    updated_by varchar(255),
    created_at timestamptz not null default now(),
    constraint uq_prompt_org_key_version unique (org_id, key, version)
);
create index if not exists ix_prompt_templates_key on prompt_templates(key);

create table if not exists metrics_daily (
    id uuid primary key default gen_random_uuid(),
    day_recording_id uuid not null references day_recordings(id),
    org_id uuid not null references organizations(id),
    location_id uuid not null references locations(id),
    employee_id uuid references employees(id),
    date date not null,
    dialogs_total integer not null default 0,
    sales_count integer not null default 0,
    conversion double precision,
    upsell_count integer not null default 0,
    avg_script_score double precision,
    summary_json jsonb,
    constraint uq_metrics_day_recording unique (day_recording_id)
);
create index if not exists ix_metrics_daily_org on metrics_daily(org_id);
create index if not exists ix_metrics_daily_recording on metrics_daily(day_recording_id);

-- RLS: enabled so Supabase anon/authenticated roles cannot read anything by
-- default. The backend connects via the direct Postgres connection (postgres
-- role, bypasses RLS). When dashboard users get org membership, add policies
-- like: using (org_id in (select org_id from org_members where user_id = auth.uid()))
alter table organizations enable row level security;
alter table locations enable row level security;
alter table employees enable row level security;
alter table day_recordings enable row level security;
alter table segments enable row level security;
alter table transcripts enable row level security;
alter table dialogs enable row level security;
alter table dialog_turns enable row level security;
alter table script_templates enable row level security;
alter table prompt_templates enable row level security;
alter table metrics_daily enable row level security;
