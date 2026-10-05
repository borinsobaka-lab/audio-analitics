-- 010: скрипты для администраторов — второй продукт админки.
--
-- Раньше скрипты переписки и звонков жили в Google-документе: длинная лента
-- на трёх языках, где нужный ответ ищется прокруткой, а копируется
-- выделением мышью вместе с лишним. Теперь это разделы и карточки скриптов,
-- которые правит владелец, а читают и копируют все вошедшие.
--
-- Тексты скрипта (варианты по студиям, сообщения, языки) лежат одним JSONB в
-- карточке: их всегда читают и сохраняют целиком, отдельные строки под
-- каждое сообщение дали бы только лишние джойны.
--
-- playbook_state помнит, что стартовый набор из документа уже загружен.
-- Без этой отметки сеть, удалившая все разделы, получила бы их обратно при
-- следующем открытии страницы.
--
-- Безопасно для повторного запуска.

begin;

create table if not exists playbook_sections (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null references organizations(id),
    title varchar(255) not null,
    position integer not null default 0,
    created_at timestamptz not null default now()
);

-- Иконка раздела в боковом меню — ключ из набора админки (calendar-add,
-- wallet-money…). Пустая строка — иконка по умолчанию.
alter table playbook_sections
    add column if not exists icon varchar(40) not null default '';

create index if not exists ix_playbook_sections_org
    on playbook_sections (org_id, position);

create table if not exists playbook_items (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null references organizations(id),
    section_id uuid not null references playbook_sections(id) on delete cascade,
    title varchar(255) not null,
    kind varchar(16) not null default 'chat',
    keywords text not null default '',
    note text not null default '',
    follow_up text not null default '',
    variants jsonb not null default '[]'::jsonb,
    position integer not null default 0,
    updated_at timestamptz not null default now(),
    updated_by varchar(255) not null default ''
);

create index if not exists ix_playbook_items_section
    on playbook_items (section_id, position);

create table if not exists playbook_state (
    org_id uuid primary key references organizations(id),
    seeded_at timestamptz not null default now()
);

commit;
