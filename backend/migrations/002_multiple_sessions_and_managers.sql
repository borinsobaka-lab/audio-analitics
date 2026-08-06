-- Migration 002. Run in the Supabase SQL editor after 001.
--
-- 1) A location may now have several recording sessions per date, so a crashed
--    app can start a fresh session instead of corrupting the existing one.
-- 2) Metrics belong to a recording session, not to a (location, date) pair.
-- 3) Employees get created_at so the managers screen can order them.

begin;

-- 1) Several recordings per day
alter table day_recordings drop constraint if exists uq_day_location;

-- 2) Metrics keyed by recording session
alter table metrics_daily add column if not exists day_recording_id uuid;

-- Attach existing metrics rows to the matching recording before enforcing NOT NULL.
update metrics_daily m
set day_recording_id = d.id
from day_recordings d
where m.day_recording_id is null
  and d.location_id = m.location_id
  and d.date = m.date;

-- Rows that cannot be matched (recording already deleted) are useless.
delete from metrics_daily where day_recording_id is null;

alter table metrics_daily drop constraint if exists uq_metrics_location_date;
alter table metrics_daily alter column day_recording_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'metrics_daily_day_recording_id_fkey'
  ) then
    alter table metrics_daily
      add constraint metrics_daily_day_recording_id_fkey
      foreign key (day_recording_id) references day_recordings(id);
  end if;
end $$;

alter table metrics_daily drop constraint if exists uq_metrics_day_recording;
alter table metrics_daily
  add constraint uq_metrics_day_recording unique (day_recording_id);

create index if not exists ix_metrics_daily_recording
  on metrics_daily(day_recording_id);

-- 3) Employees
alter table employees
  add column if not exists created_at timestamptz not null default now();

commit;
