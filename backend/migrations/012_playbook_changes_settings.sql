-- 012: история правки скрипта и настройки продукта «Скрипты».
--
-- 1. change_note — что изменили при последней правке. Админка спрашивает его
--    при каждом сохранении и показывает внизу карточки вместе с тем, кто и
--    когда правил: скрипт меняется у всех сразу, и человеку у стойки важно
--    понимать, почему текст стал другим.
-- 2. playbook_settings — названия студий и имена администраторов на трёх
--    языках и свои переменные. Переменные пишутся в тексте в фигурных скобках
--    ({админ}, {студия}, {любая_своя}) и подставляются при показе и
--    копировании — на выбранном языке, для выбранной студии и того, кто вошёл.
-- 3. В уже загруженных скриптах имена из документа («Меня зовут Анастасия»,
--    «Это Мария») заменяются на {админ}: дальше каждый администратор видит
--    в тексте своё имя. Меняются только точные фразы из документа — то, что
--    успели переписать руками, не трогается.
--
-- Безопасно для повторного запуска.

begin;

alter table playbook_items
    add column if not exists change_note text not null default '';

update playbook_items
   set change_note = 'Перенесено из документа «Скрипты LS Tbilisi»'
 where change_note = '' and updated_by = 'перенесено из документа';

create table if not exists playbook_settings (
    org_id uuid primary key references organizations(id),
    data jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now(),
    updated_by varchar(255) not null default ''
);

update playbook_items
   set variants = replace(replace(replace(replace(variants::text,
           'Меня зовут Анастасия', 'Меня зовут {админ}'),
           'My name is Anastasia', 'My name is {админ}'),
           'მე ანასტასია მქვია', 'მე {админ} მქვია'),
           'Это Мария, студия', 'Это {админ}, студия')::jsonb,
       change_note = 'Имя администратора заменено переменной {админ} — подставляется имя того, кто вошёл',
       updated_at = now(),
       updated_by = 'обновление 012'
 where variants::text like '%Меня зовут Анастасия%'
    or variants::text like '%My name is Anastasia%'
    or variants::text like '%მე ანასტასია მქვია%'
    or variants::text like '%Это Мария, студия%';

commit;
