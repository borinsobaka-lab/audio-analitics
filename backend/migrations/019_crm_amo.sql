-- 019: коннектор amoCRM.
--
-- crm_deals.contact_key — id контакта в CRM. Сообщение из чата amoCRM
-- приходит вебхуком и бывает привязано не к сделке, а к контакту (пока
-- заявку не приняли из «Неразобранного»): по контакту находится его
-- последняя сделка, и переписка не теряется.
--
-- Сами настройки подключения (поддомен, токен, курсоры синхронизации)
-- живут в crm_settings.data под ключом "amo" — отдельной таблицы не нужно.
--
-- Безопасно для повторного запуска.

begin;

alter table crm_deals
    add column if not exists contact_key varchar(64) not null default '';

create index if not exists ix_crm_deals_org_contact on crm_deals (org_id, contact_key);

commit;
