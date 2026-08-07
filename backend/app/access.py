"""Проверки видимости смен — в одном месте, а не в каждом обработчике.

Правило одно: сотрудник с доступом «только свои» видит смены, на которых
стоит его имя. Всё остальное для него не существует — не «нельзя», а «не
найдено»: отвечать «403» на чужую смену значит подтверждать, что такая смена
есть, а по её идентификатору можно перебирать.
"""
import uuid

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import Select

from .auth import UserContext
from .models import DayRecording


def scope_days(query: Select, user: UserContext) -> Select:
    """Сузить выборку смен до тех, что положены пользователю."""
    if user.can_view_all:
        return query
    if not user.employee_id:
        # Вход есть, а карточки менеджера нет — показывать нечего.
        return query.where(DayRecording.id.is_(None))
    return query.where(DayRecording.employee_id == user.employee_id)


async def visible_day(
    db: AsyncSession, recording_id: uuid.UUID, user: UserContext
) -> DayRecording:
    rec = await db.get(DayRecording, recording_id)
    if not rec or not user.may_see_employee(rec.employee_id):
        raise HTTPException(404, "Смена не найдена")
    return rec
