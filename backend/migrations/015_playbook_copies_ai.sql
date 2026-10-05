-- 015: статистика копирований скриптов.
--
-- playbook_copies — каждое нажатие «Копировать» у текста скрипта: какой
-- скрипт, кто, на каком языке, вариант какой студии и откуда (карточка или
-- окно ИИ-помощника). По ней строится «Настройки» → «Статистика».
--
-- Промпт ИИ-помощника отдельной таблицы не требует: он хранится в
-- настройках скриптов (playbook_settings.data).
--
-- Безопасно для повторного запуска.

begin;

create table if not exists playbook_copies (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null references organizations(id),
    item_id uuid,
    item_title varchar(255) not null default '',
    user_key varchar(64) not null,
    user_name varchar(255) not null default '',
    lang varchar(2) not null,
    studio varchar(120) not null default '',
    source varchar(16) not null default 'card',
    created_at timestamptz not null default now()
);

create index if not exists ix_playbook_copies_org_time
    on playbook_copies (org_id, created_at);
create index if not exists ix_playbook_copies_org_user_time
    on playbook_copies (org_id, user_key, created_at);

commit;
