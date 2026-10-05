-- 007: отзыв остаётся только у оценки метрики.
--
-- Под карточкой разговора стояли два вопроса подряд — «оценка справедлива?»
-- у каждой метрики и «согласны с разбором разговора?» внизу. Они спрашивали
-- почти одно и то же, а с несогласием «вообще» нечего было делать: править
-- можно промпт конкретной метрики, а не разбор в целом. Общий голос убран.
--
-- Голоса «за разбор целиком» удаляются: показать их больше негде, а висеть
-- невидимыми строками в базе им незачем. Голоса по метрикам не трогаются.

begin;

delete from dialog_feedback where metric_id is null;

-- Частичный уникальный индекс «один общий голос на разговор» больше не нужен.
drop index if exists uq_feedback_dialog_overall;

alter table dialog_feedback
    alter column metric_id set not null;

-- Второй индекс был частичным (where metric_id is not null) только потому,
-- что колонка допускала NULL. Теперь — обычный уникальный.
drop index if exists uq_feedback_dialog_metric;
create unique index if not exists uq_feedback_dialog_metric
    on dialog_feedback (dialog_id, metric_id, author_key);

commit;
