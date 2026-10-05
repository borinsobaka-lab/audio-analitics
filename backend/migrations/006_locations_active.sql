-- 006: точки продажи заводятся в админке, приложение выбирает их из списка.
--
-- Таблица locations существует с первой миграции; здесь ей добавляется только
-- признак «работает». Закрытая точка исчезает из выбора в приложении записи,
-- но её прошлые смены и отчёты остаются на месте.

begin;

alter table locations
    add column if not exists active boolean not null default true;

-- Имя точки набирают руками в админке; два «Ваке» в списке приложения
-- сотрудник различить не сможет.
create unique index if not exists uq_locations_name
    on locations (lower(name));

commit;
