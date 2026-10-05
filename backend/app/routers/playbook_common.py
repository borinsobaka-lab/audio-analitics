"""Общее для роутеров скриптов: кто правит, чья организация, страницы по
курсору и ответ на ещё не выполненную миграцию."""
import uuid
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import UserContext
from ..models import Organization

# Размер порции хронологии и предложений.
PAGE = 20


def author(user: UserContext) -> str:
    if user.is_owner:
        return "Владелец"
    return user.full_name or user.email or "владелец"


async def current_org(db: AsyncSession) -> Organization:
    org = await db.scalar(select(Organization).limit(1))
    if not org:
        raise HTTPException(400, "Организация не создана — выполните seed")
    return org


def missing_migration(what: str, migration: str) -> HTTPException:
    """Таблицы ещё нет — миграцию не выполнили. Порядок «миграция, потом
    деплой» не должен ломать остальное: отвечаем 503 с подсказкой, а не 500."""
    return HTTPException(503, f"{what} ещё не включена: выполните миграцию {migration}")


# --- Страницы по курсору ---
# Курсор — время и id последней записи порции: в отличие от номера
# страницы, он не съезжает, когда между порциями кто-то добавил запись.

def encode_cursor(created_at, row_id) -> str:
    return f"{created_at.isoformat()}|{row_id}"


def decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        at, row_id = cursor.split("|", 1)
        return datetime.fromisoformat(at), uuid.UUID(row_id)
    except ValueError:
        raise HTTPException(400, "Неверный курсор") from None


async def page_by_time(db: AsyncSession, q, model, cursor: str, limit: int) -> tuple[list, str]:
    """Порция записей от новых к старым и курсор следующей (пусто — конец).
    У model должны быть created_at и id."""
    limit = max(1, min(limit, 50))
    if cursor:
        at, row_id = decode_cursor(cursor)
        q = q.where((model.created_at < at) | ((model.created_at == at) & (model.id < row_id)))
    rows = (
        await db.scalars(q.order_by(model.created_at.desc(), model.id.desc()).limit(limit + 1))
    ).all()
    more = len(rows) > limit
    rows = rows[:limit]
    return rows, encode_cursor(rows[-1].created_at, rows[-1].id) if more and rows else ""
