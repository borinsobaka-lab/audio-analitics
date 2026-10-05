-- Migration 004. Run in the Supabase SQL editor after 003.
-- Стоимость обработки смены.
--
-- Хранится не только итоговая сумма, но и сам расход: минуты распознавания и
-- токены модели. Тарифы меняются, и по сохранённому расходу прошлые смены
-- можно пересчитать по новым ценам, а по одной сумме — уже нет.

begin;

alter table day_recordings
    add column if not exists asr_seconds double precision,
    add column if not exists llm_input_tokens integer not null default 0,
    add column if not exists llm_output_tokens integer not null default 0,
    add column if not exists llm_calls integer not null default 0,
    add column if not exists cost_usd double precision;

-- Дашборд считает суммы за произвольный период по дате смены.
create index if not exists ix_day_recordings_org_date on day_recordings(org_id, date);

commit;
