-- 008: сборки приложения записи — автообновление вместо обхода студий с флешкой.
--
-- Архив лежит в объектном хранилище рядом с записями, здесь — только метаданные
-- и подпись. Подпись обязательна: приложение проверяет её вшитым публичным
-- ключом и не установит архив, подписанный не владельцем.

begin;

create table if not exists app_releases (
    id              uuid primary key default gen_random_uuid(),
    org_id          uuid not null references organizations(id),
    -- darwin | windows | linux — то, что присылает апдейтер в {{target}}
    platform        varchar(32) not null,
    version         varchar(32) not null,
    notes           text not null default '',
    archive_uri     varchar(512) not null,
    signature       text not null,
    size_bytes      integer not null default 0,
    published       boolean not null default true,
    created_by_name varchar(255) not null default '',
    created_at      timestamptz not null default now(),
    constraint uq_release_platform_version unique (platform, version)
);

create index if not exists ix_app_releases_org      on app_releases (org_id);
create index if not exists ix_app_releases_platform on app_releases (platform);

commit;
