-- 014: предложение изменений привязано к скрипту.
--
-- «Предложить изменения» теперь стоит на шапке каждого скрипта: в
-- предложении запоминается, к какому скрипту оно (id и название на момент
-- отправки — скрипт могут переименовать или удалить).
--
-- Нужна после 013. Безопасно для повторного запуска.

begin;

alter table playbook_suggestions add column if not exists item_id uuid;
alter table playbook_suggestions add column if not exists item_title varchar(255) not null default '';

commit;
