-- 017: аналитика звонков — каждый проход сценария звонка.
--
-- playbook_call_runs — один звонок по сценарию: кто звонил, по какому
-- разделу-звонку, какие блоки прошёл и что отвечал клиент на каждом шаге
-- (path), чем закончилось (outcome) и сколько длилось. Админка пишет строку
-- по ходу разговора — после каждого клика, — поэтому даже брошенный на
-- середине звонок виден: на каком шаге он оборвался.
--
-- По ней строится «Аналитика» → «Звонки»: воронка по этапам сценария, где
-- отваливаются клиенты, возражения, ответы клиентов и сравнение
-- администраторов.
--
-- section_id намеренно без внешнего ключа: удалили раздел — статистика
-- звонков по нему остаётся под последним названием.
--
-- Заодно блокам стартового сценария «Запись» и «Перезвоню» проставляется
-- итог звонка (см. ниже).
--
-- Безопасно для повторного запуска.

begin;

create table if not exists playbook_call_runs (
    id uuid primary key,
    org_id uuid not null references organizations(id),
    section_id uuid not null,
    section_title varchar(255) not null default '',
    user_key varchar(64) not null,
    user_name varchar(255) not null default '',
    studio varchar(120) not null default '',
    lang varchar(2) not null default 'ru',
    -- Версия сценария (время его последней правки) на момент звонка: чтобы
    -- сравнивать, как работал сценарий до и после правки.
    flow_version timestamptz,
    -- [{"id", "title", "group", "answer", "at"}] — пройденные блоки по порядку.
    path jsonb not null default '[]'::jsonb,
    steps integer not null default 0,
    last_node_id varchar(40) not null default '',
    last_node_title varchar(120) not null default '',
    -- booked | callback | refused | no_answer | '' (итог не отмечен).
    outcome varchar(16) not null default '',
    started_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    -- Звонок завершён: дошли до конца сценария или отметили итог.
    ended_at timestamptz
);

create index if not exists ix_playbook_call_runs_org_time
    on playbook_call_runs (org_id, started_at);
create index if not exists ix_playbook_call_runs_org_section_time
    on playbook_call_runs (org_id, section_id, started_at);
create index if not exists ix_playbook_call_runs_org_user_time
    on playbook_call_runs (org_id, user_key, started_at);

-- Итоги в стартовом сценарии: дошли до блока «Запись» — записан, до
-- «Перезвоню» — перезвонить. Так конверсия считается без лишних кликов
-- администратора. Только там, где итог у блока ещё не задан.
update playbook_call_flows f
set flow = jsonb_set(
    f.flow,
    '{nodes}',
    (
        select jsonb_agg(
            case
                when n->>'id' = 'booked' and coalesce(n->>'outcome', '') = ''
                    then n || '{"outcome": "booked"}'::jsonb
                when n->>'id' = 'callback_end' and coalesce(n->>'outcome', '') = ''
                    then n || '{"outcome": "callback"}'::jsonb
                else n
            end
            order by t.ord
        )
        from jsonb_array_elements(f.flow->'nodes') with ordinality as t(n, ord)
    )
)
where jsonb_typeof(f.flow->'nodes') = 'array'
  and jsonb_array_length(f.flow->'nodes') > 0;

commit;
