-- Migration 003. Run in the Supabase SQL editor after 002.
-- Owner-defined analysis metrics and their per-dialog evaluations.

begin;

create table if not exists analysis_metrics (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null references organizations(id),
    name varchar(255) not null,
    prompt text not null,
    scale_max integer not null default 10,
    active boolean not null default true,
    position integer not null default 0,
    created_at timestamptz not null default now()
);
create index if not exists ix_analysis_metrics_org on analysis_metrics(org_id);

create table if not exists metric_evaluations (
    id uuid primary key default gen_random_uuid(),
    day_recording_id uuid not null references day_recordings(id),
    dialog_id uuid not null references dialogs(id),
    metric_id uuid not null references analysis_metrics(id),
    applicable boolean not null default false,
    score integer,
    good_json jsonb not null default '[]',
    bad_json jsonb not null default '[]',
    comment text not null default '',
    constraint uq_metric_eval_dialog unique (dialog_id, metric_id)
);
create index if not exists ix_metric_evaluations_day on metric_evaluations(day_recording_id);
create index if not exists ix_metric_evaluations_metric on metric_evaluations(metric_id);

alter table analysis_metrics enable row level security;
alter table metric_evaluations enable row level security;

commit;
