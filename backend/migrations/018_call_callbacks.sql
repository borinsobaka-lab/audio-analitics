-- 018: звонки — клиент, «перезвонить» и связь с записью смены.
--
-- К звонку по сценарию добавляются имя и телефон клиента (вписываются в
-- сценарии сверху) и данные для списка «Перезвонить»: когда перезвонить,
-- комментарий, кто и когда закрыл перезвон. Звонок с итогом «Перезвонить»
-- попадает в список у раздела-звонка, пока его не отметят сделанным или
-- пока по нему не проведут новый звонок.
--
-- Цель по конверсии, версии сценария, «Нет нужного ответа» по шагам и
-- связь с записью смены новых таблиц не требуют: цель лежит в настройках
-- скриптов, остальное считается по уже записанным звонкам.
--
-- Безопасно для повторного запуска.

begin;

alter table playbook_call_runs add column if not exists client_name varchar(120) not null default '';
alter table playbook_call_runs add column if not exists client_phone varchar(40) not null default '';
alter table playbook_call_runs add column if not exists callback_at timestamptz;
alter table playbook_call_runs add column if not exists callback_note text not null default '';
alter table playbook_call_runs add column if not exists callback_done_at timestamptz;
alter table playbook_call_runs add column if not exists callback_done_by varchar(255) not null default '';
-- Звонок, сделанный по перезвону: когда он завершён, перезвон закрывается сам.
alter table playbook_call_runs add column if not exists callback_of uuid;

create index if not exists ix_playbook_call_runs_callbacks
    on playbook_call_runs (org_id, outcome, callback_done_at);

commit;
