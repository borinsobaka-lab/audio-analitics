"""Хронология правок скриптов и предложения сотрудников.

Хронологию видят все: «почему текст стал другим» — вопрос и того, кто
скрипты только читает. Предложить может любой, кто видит скрипты; у
каждого свой счётчик непрочитанных.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import UserContext, require_scripts_edit, require_user
from ..db import get_db
from ..models import PlaybookChange, PlaybookItem, PlaybookSeen, PlaybookSuggestion, utcnow
from ..schemas import (
    PlaybookChangeOut,
    PlaybookChangesPage,
    PlaybookSuggestionIn,
    PlaybookSuggestionOut,
    PlaybookSuggestionPatch,
    PlaybookSuggestionsPage,
    UnreadOut,
)
from .playbook_common import PAGE, author, current_org, page_by_time

router = APIRouter(prefix="/api/playbook", tags=["playbook"])


# --- Хронология изменений ---

@router.get("/changes", response_model=PlaybookChangesPage)
async def list_changes(
    cursor: str = "",
    limit: int = PAGE,
    # Хронологию видят все: «почему текст стал другим» — вопрос и того, кто
    # скрипты только читает.
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Порциями, от новых к старым."""
    org = await current_org(db)
    q = select(PlaybookChange).where(PlaybookChange.org_id == org.id)
    rows, next_cursor = await page_by_time(db, q, PlaybookChange, cursor, limit)
    return PlaybookChangesPage(
        items=[PlaybookChangeOut.model_validate(r) for r in rows], next_cursor=next_cursor
    )


# --- Предложения сотрудников ---

async def seen_at(db: AsyncSession, user: UserContext):
    row = await db.get(PlaybookSeen, user.author_key)
    return row.suggestions_seen_at if row else None


@router.post("/suggestions", response_model=PlaybookSuggestionOut, status_code=201)
async def create_suggestion(
    body: PlaybookSuggestionIn,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Предложить может любой, кто видит скрипты: замечают неудачный текст
    чаще всего те, кто им пользуется у стойки."""
    org = await current_org(db)
    item = None
    if body.item_id:
        item = await db.get(PlaybookItem, body.item_id)
        if not item or item.org_id != org.id:
            raise HTTPException(404, "Скрипт не найден — возможно, его удалили")
    row = PlaybookSuggestion(
        org_id=org.id,
        author_key=user.author_key,
        author_name=author(user),
        item_id=item.id if item else None,
        item_title=item.title if item else "",
        text=body.text.strip(),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@router.get("/suggestions", response_model=PlaybookSuggestionsPage)
async def list_suggestions(
    cursor: str = "",
    limit: int = PAGE,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    org = await current_org(db)
    seen = await seen_at(db, user)
    q = select(PlaybookSuggestion).where(PlaybookSuggestion.org_id == org.id)
    rows, next_cursor = await page_by_time(db, q, PlaybookSuggestion, cursor, limit)
    items = []
    for r in rows:
        out = PlaybookSuggestionOut.model_validate(r)
        out.unread = r.author_key != user.author_key and (seen is None or r.created_at > seen)
        items.append(out)
    return PlaybookSuggestionsPage(items=items, next_cursor=next_cursor)


@router.patch("/suggestions/{suggestion_id}", response_model=PlaybookSuggestionOut)
async def update_suggestion(
    suggestion_id: uuid.UUID,
    body: PlaybookSuggestionPatch,
    user: UserContext = Depends(require_scripts_edit),
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(PlaybookSuggestion, suggestion_id)
    if not row:
        raise HTTPException(404, "Предложение не найдено")
    row.status = body.status
    row.resolved_at = utcnow() if body.status == "done" else None
    row.resolved_by = author(user) if body.status == "done" else ""
    await db.commit()
    await db.refresh(row)
    return row


@router.get("/suggestions/unread", response_model=UnreadOut)
async def unread_suggestions(
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Сколько новых предложений этот сотрудник ещё не видел. Свои не
    считаются. Настройки скриптов открыты всем — и значок у всех свой."""
    org = await current_org(db)
    seen = await seen_at(db, user)
    q = select(func.count()).select_from(PlaybookSuggestion).where(
        PlaybookSuggestion.org_id == org.id,
        PlaybookSuggestion.author_key != user.author_key,
    )
    if seen is not None:
        q = q.where(PlaybookSuggestion.created_at > seen)
    return UnreadOut(count=(await db.scalar(q)) or 0)


@router.post("/suggestions/seen", response_model=UnreadOut)
async def mark_suggestions_seen(
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    # Одним запросом: два открытия вкладки подряд (две вкладки браузера)
    # иначе спорят за одну строку и второе падает на уникальном ключе.
    now = utcnow()
    await db.execute(
        pg_insert(PlaybookSeen)
        .values(user_key=user.author_key, suggestions_seen_at=now)
        .on_conflict_do_update(
            index_elements=[PlaybookSeen.user_key], set_={"suggestions_seen_at": now}
        )
    )
    await db.commit()
    return UnreadOut(count=0)
