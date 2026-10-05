-- 013: хронология изменений скриптов и предложения сотрудников.
--
-- 1. playbook_changes — журнал: каждое создание, правка и удаление скрипта
--    с полными версиями «до» и «после». В настройках по нему видно, что с
--    чего поменялось, кто и зачем. Журнал не зависит от самого скрипта:
--    удалённый скрипт в нём остаётся с последней версией.
-- 2. playbook_suggestions — «Предложить изменения»: сотрудник у стойки
--    пишет, что стоит поправить, администраторы видят это в настройках.
-- 3. playbook_seen — когда каждый администратор последний раз смотрел
--    предложения: значок непрочитанного у каждого свой.
--
-- Безопасно для повторного запуска.

begin;

create table if not exists playbook_changes (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null references organizations(id),
    item_id uuid,
    item_title varchar(255) not null default '',
    action varchar(16) not null,            -- created | updated | deleted
    before jsonb,
    after jsonb,
    change_note text not null default '',
    author varchar(255) not null default '',
    created_at timestamptz not null default now()
);

create index if not exists ix_playbook_changes_org_time
    on playbook_changes (org_id, created_at desc, id desc);

create table if not exists playbook_suggestions (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null references organizations(id),
    author_key varchar(64) not null,
    author_name varchar(255) not null default '',
    text text not null,
    status varchar(16) not null default 'open',   -- open | done
    created_at timestamptz not null default now(),
    resolved_at timestamptz,
    resolved_by varchar(255) not null default ''
);

create index if not exists ix_playbook_suggestions_org_time
    on playbook_suggestions (org_id, created_at desc, id desc);

create table if not exists playbook_seen (
    user_key varchar(64) primary key,
    suggestions_seen_at timestamptz not null default now()
);

commit;
