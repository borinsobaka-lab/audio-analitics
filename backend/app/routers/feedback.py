"""«Согласен / не согласен» с оценкой разговора.

Зачем это в продукте. Разбор делает модель, а работает по нему человек, и
если человек считает оценку несправедливой, у него должен быть способ это
сказать — иначе разбор превращается в приговор, который слушают молча.
Одновременно это единственный честный источник данных о качестве самих
промптов: одна метрика, собравшая несогласия на разных сменах у разных
людей, почти наверняка плохо сформулирована.

Голос всегда относится к конкретной оценке. Отдельного «согласен с разбором
разговора целиком» нет: возражение «вообще» нечем починить, править можно
только промпт метрики, к которой оно относится.

Голоса копятся в разрезе метрики (см. /by-metric) со ссылкой на день и
разговор: из списка несогласий можно уйти прямо в карточку смены и
послушать спорное место.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..access import visible_day
from ..auth import UserContext, require_manage, require_user
from ..db import get_db
from ..models import AnalysisMetric, DayRecording, Dialog, DialogFeedback, Employee
from ..schemas import (
    DialogFeedbackOut,
    FeedbackIn,
    MetricFeedbackItem,
    MetricFeedbackStat,
)

router = APIRouter(prefix="/api/feedback", tags=["feedback"])


def to_out(row: DialogFeedback, user: UserContext) -> DialogFeedbackOut:
    return DialogFeedbackOut(
        id=row.id,
        dialog_id=row.dialog_id,
        metric_id=row.metric_id,
        agree=row.agree,
        comment=row.comment,
        author_name=row.author_name,
        subject_name=row.subject_name,
        created_at=row.created_at,
        is_mine=row.author_key == user.author_key,
    )


async def feedback_for_day(
    db: AsyncSession, recording_id: uuid.UUID, user: UserContext
) -> list[DialogFeedbackOut]:
    rows = await db.scalars(
        select(DialogFeedback)
        .where(
            DialogFeedback.day_recording_id == recording_id,
            # Голоса «за разбор целиком» из прежней версии не показываем: их
            # больше некуда поставить, а миграция подчистит их совсем.
            DialogFeedback.metric_id.isnot(None),
        )
        .order_by(DialogFeedback.created_at)
    )
    return [to_out(row, user) for row in rows]


@router.post("", response_model=DialogFeedbackOut, status_code=201)
async def leave_feedback(
    body: FeedbackIn,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    dialog = await db.get(Dialog, body.dialog_id)
    if not dialog:
        raise HTTPException(404, "Разговор не найден")
    rec = await visible_day(db, dialog.day_recording_id, user)

    if not await db.get(AnalysisMetric, body.metric_id):
        raise HTTPException(404, "Метрика не найдена")

    subject_name = ""
    if rec.employee_id:
        subject = await db.get(Employee, rec.employee_id)
        subject_name = subject.full_name if subject else ""

    existing = await db.scalar(
        select(DialogFeedback).where(
            DialogFeedback.dialog_id == body.dialog_id,
            DialogFeedback.author_key == user.author_key,
            DialogFeedback.metric_id == body.metric_id,
        )
    )
    if existing:
        # Повторное нажатие меняет мнение, а не добавляет второй голос.
        existing.agree = body.agree
        existing.comment = body.comment.strip()
        row = existing
    else:
        row = DialogFeedback(
            org_id=rec.org_id,
            day_recording_id=rec.id,
            dialog_id=dialog.id,
            metric_id=body.metric_id,
            author_key=user.author_key,
            author_employee_id=user.employee_id,
            author_name=user.full_name or ("Владелец" if user.is_owner else "Аноним"),
            subject_employee_id=rec.employee_id,
            subject_name=subject_name,
            agree=body.agree,
            comment=body.comment.strip(),
        )
        db.add(row)
    await db.commit()
    await db.refresh(row)
    return to_out(row, user)


@router.delete("/{feedback_id}", status_code=204)
async def withdraw_feedback(
    feedback_id: uuid.UUID,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Снять свой голос. Чужие голоса не трогает никто, включая владельца:
    отзыв — это высказывание человека, а не поле в отчёте."""
    row = await db.get(DialogFeedback, feedback_id)
    if not row:
        raise HTTPException(404, "Отзыв не найден")
    if row.author_key != user.author_key:
        raise HTTPException(403, "Это чужой отзыв")
    await db.delete(row)
    await db.commit()
    return None


@router.get("/by-metric", response_model=list[MetricFeedbackStat])
async def feedback_by_metric(
    user: UserContext = Depends(require_manage),
    db: AsyncSession = Depends(get_db),
):
    """Сводка для раздела метрик: сколько согласий и несогласий собрал каждый
    промпт и где именно возражали."""
    rows = (
        await db.execute(
            select(DialogFeedback, DayRecording.date, Dialog.start_s, AnalysisMetric.name)
            .join(DayRecording, DayRecording.id == DialogFeedback.day_recording_id)
            .join(Dialog, Dialog.id == DialogFeedback.dialog_id)
            # Внутреннее соединение отсекает и голоса «за разбор целиком» из
            # прежней версии, и отзывы по удалённым метрикам.
            .join(AnalysisMetric, AnalysisMetric.id == DialogFeedback.metric_id)
            .order_by(DayRecording.date.desc(), DialogFeedback.created_at.desc())
        )
    ).all()

    stats: dict[uuid.UUID, MetricFeedbackStat] = {}
    for row, day_date, start_s, metric_name in rows:
        stat = stats.get(row.metric_id)
        if stat is None:
            stat = MetricFeedbackStat(metric_id=row.metric_id, metric_name=metric_name)
            stats[row.metric_id] = stat
        if row.agree:
            stat.agree_count += 1
            continue
        stat.disagree_count += 1
        stat.disagreements.append(
            MetricFeedbackItem(
                id=row.id,
                day_recording_id=row.day_recording_id,
                day_date=day_date,
                dialog_id=row.dialog_id,
                dialog_start_s=start_s,
                subject_name=row.subject_name,
                author_name=row.author_name,
                comment=row.comment,
                created_at=row.created_at,
            )
        )

    # Сверху то, что спорят чаще всего: это и есть очередь на правку промптов.
    return sorted(stats.values(), key=lambda s: (-s.disagree_count, s.metric_name))
