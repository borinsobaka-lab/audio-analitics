"""Скрипты администраторов — второй продукт админки.

Речевая аналитика проверяет, как администратор говорит; скрипты подсказывают,
что говорить. Раньше они жили в Google-документе: лента на трёх языках, где
нужный ответ ищется прокруткой, а копируется выделением мышью — вместе с
пометками «RU:» и «После отправки…», которые потом приходится стирать в чате.

Читают скрипты все вошедшие: менеджер на ресепшене — главный их читатель.
Правят те, кому в карточке сотрудника выдано «Скрипты: правка», и владелец.

Стартовый набор — перенос того самого документа (playbook_default.json). Он
загружается сам при первом открытии раздела, ровно один раз: отметка в
playbook_state не даёт удалённым разделам вернуться.
"""
import json
import logging
import uuid
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError, ProgrammingError
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import UserContext, require_scripts_edit, require_user
from ..db import get_db
from ..models import (
    PlaybookChange,
    PlaybookSeen,
    PlaybookSuggestion,
    Employee,
    Location,
    Organization,
    PlaybookItem,
    PlaybookSection,
    PlaybookSettings,
    PlaybookState,
    utcnow,
)
from ..schemas import (
    PlaybookItemIn,
    PlaybookItemOut,
    PlaybookOrder,
    PlaybookOut,
    PlaybookSectionIn,
    PlaybookSectionOut,
    PlaybookSectionPatch,
    PlaybookChangeOut,
    PlaybookChangesPage,
    PlaybookSettingsIn,
    PlaybookSuggestionIn,
    PlaybookSuggestionOut,
    PlaybookSuggestionPatch,
    PlaybookSuggestionsPage,
    UnreadOut,
    PlaybookSettingsOut,
    AdminNamesOut,
    StudioNamesOut,
)

router = APIRouter(prefix="/api/playbook", tags=["playbook"])
log = logging.getLogger(__name__)

DEFAULT_PATH = Path(__file__).resolve().parents[1] / "playbook_default.json"
SEED_NOTE = "Перенесено из документа «Скрипты LS Tbilisi»"


@lru_cache
def default_playbook() -> list[tuple[str, str, list[PlaybookItemIn]]]:
    """Стартовые разделы и скрипты, проверенные той же схемой, что и правки
    из админки: битый файл должен падать в тестах, а не у владельца."""
    raw = json.loads(DEFAULT_PATH.read_text(encoding="utf-8"))
    placeholder = uuid.UUID(int=0)
    sections = []
    for section in raw["sections"]:
        items = [
            PlaybookItemIn(
                section_id=placeholder,
                title=item["title"],
                kind=item.get("kind", "chat"),
                keywords=item.get("keywords", ""),
                note=item.get("note", ""),
                follow_up=item.get("follow_up", ""),
                variants=item["variants"],
            )
            for item in section["items"]
        ]
        sections.append((section["title"], section.get("icon", ""), items))
    return sections


def clean_variants(body: PlaybookItemIn) -> list[dict]:
    """Тексты без пустых краёв и виндовых переводов строк: в чат копируется
    ровно то, что видно на экране."""

    def clean(text: str) -> str:
        return text.replace("\r\n", "\n").strip()

    return [
        {
            "label": variant.label.strip(),
            "messages": [
                {
                    "label": message.label.strip(),
                    "ru": clean(message.ru),
                    "en": clean(message.en),
                    "ka": clean(message.ka),
                }
                for message in variant.messages
            ],
        }
        for variant in body.variants
    ]


def author(user: UserContext) -> str:
    if user.is_owner:
        return "Владелец"
    return user.full_name or user.email or "владелец"


async def current_org(db: AsyncSession) -> Organization:
    org = await db.scalar(select(Organization).limit(1))
    if not org:
        raise HTTPException(400, "Организация не создана — выполните seed")
    return org


async def ensure_seeded(db: AsyncSession, org: Organization) -> None:
    if await db.get(PlaybookState, org.id):
        return
    # Разделы могли завести руками ещё до первой загрузки — тогда документ
    # поверх не льём, только ставим отметку.
    has_sections = await db.scalar(
        select(PlaybookSection.id).where(PlaybookSection.org_id == org.id).limit(1)
    )
    if not has_sections:
        for s_pos, (title, icon, items) in enumerate(default_playbook()):
            section = PlaybookSection(org_id=org.id, title=title, icon=icon, position=s_pos)
            db.add(section)
            await db.flush()
            for i_pos, item in enumerate(items):
                db.add(
                    PlaybookItem(
                        org_id=org.id,
                        section_id=section.id,
                        title=item.title,
                        kind=item.kind,
                        keywords=item.keywords.strip(),
                        note=item.note.strip(),
                        follow_up=item.follow_up.strip(),
                        variants=clean_variants(item),
                        position=i_pos,
                        updated_by="перенесено из документа",
                        change_note=SEED_NOTE,
                    )
                )
    db.add(PlaybookState(org_id=org.id))
    try:
        await db.commit()
    except IntegrityError:
        # Два первых открытия одновременно: отметку поставил соседний запрос,
        # его набор и остаётся, наш откатывается целиком.
        await db.rollback()


async def get_section(db: AsyncSession, section_id: uuid.UUID) -> PlaybookSection:
    section = await db.get(PlaybookSection, section_id)
    if not section:
        raise HTTPException(404, "Раздел не найден")
    return section


async def get_item(db: AsyncSession, item_id: uuid.UUID) -> PlaybookItem:
    item = await db.get(PlaybookItem, item_id)
    if not item:
        raise HTTPException(404, "Скрипт не найден")
    return item


async def snapshot(db: AsyncSession, item: PlaybookItem) -> dict:
    """Версия скрипта для хронологии — всё, что видно в карточке."""
    section = await db.get(PlaybookSection, item.section_id)
    return {
        "title": item.title,
        "kind": item.kind,
        "section": section.title if section else "",
        "keywords": item.keywords,
        "note": item.note,
        "follow_up": item.follow_up,
        "variants": item.variants,
    }


async def record(
    db: AsyncSession,
    item: PlaybookItem,
    action: str,
    user: UserContext,
    before: dict | None,
    after: dict | None,
    note: str,
) -> None:
    """Запись в хронологию — в точке сохранения: если миграция 013 ещё не
    выполнена и таблицы нет, правка скрипта всё равно сохраняется, просто
    без записи в журнал. Порядок «миграция, потом деплой» не должен ломать
    работу у стойки."""
    try:
        async with db.begin_nested():
            db.add(
                PlaybookChange(
                    org_id=item.org_id,
                    item_id=item.id,
                    item_title=(after or before or {}).get("title", item.title),
                    action=action,
                    before=before,
                    after=after,
                    change_note=note,
                    author=author(user),
                )
            )
    except ProgrammingError as exc:
        if "playbook_changes" not in str(exc):
            raise
        log.warning("Хронология скриптов не записана: нет таблицы playbook_changes (миграция 013)")


def encode_cursor(created_at, row_id) -> str:
    return f"{created_at.isoformat()}|{row_id}"


def decode_cursor(cursor: str):
    from datetime import datetime as dt

    try:
        at, row_id = cursor.split("|", 1)
        return dt.fromisoformat(at), uuid.UUID(row_id)
    except ValueError:
        raise HTTPException(400, "Неверный курсор") from None


async def next_position(db: AsyncSession, model, *where) -> int:
    last = await db.scalar(select(func.max(model.position)).where(*where))
    return 0 if last is None else last + 1


@router.get("", response_model=PlaybookOut)
async def get_playbook(
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Всё дерево разом: скриптов десятки, а не тысячи, и поиск по ним
    мгновенный, только когда тексты уже в браузере."""
    org = await current_org(db)
    await ensure_seeded(db, org)

    sections = (
        await db.scalars(
            select(PlaybookSection)
            .where(PlaybookSection.org_id == org.id)
            .order_by(PlaybookSection.position, PlaybookSection.created_at)
        )
    ).all()
    items = (
        await db.scalars(
            select(PlaybookItem)
            .where(PlaybookItem.org_id == org.id)
            .order_by(PlaybookItem.position, PlaybookItem.title)
        )
    ).all()
    by_section: dict[uuid.UUID, list[PlaybookItemOut]] = {}
    for item in items:
        by_section.setdefault(item.section_id, []).append(
            PlaybookItemOut.model_validate(item)
        )
    return PlaybookOut(
        sections=[
            PlaybookSectionOut(
                id=s.id,
                title=s.title,
                icon=s.icon or "",
                position=s.position,
                items=by_section.get(s.id, []),
            )
            for s in sections
        ]
    )


# --- Разделы ---

@router.post("/sections", response_model=PlaybookSectionOut, status_code=201)
async def create_section(
    body: PlaybookSectionIn,
    user: UserContext = Depends(require_scripts_edit),
    db: AsyncSession = Depends(get_db),
):
    org = await current_org(db)
    title = body.title.strip()
    if not title:
        raise HTTPException(422, "Название раздела не может быть пустым")
    section = PlaybookSection(
        org_id=org.id,
        title=title,
        icon=body.icon,
        position=await next_position(
            db, PlaybookSection, PlaybookSection.org_id == org.id
        ),
    )
    db.add(section)
    await db.commit()
    await db.refresh(section)
    return section_out(section)


def section_out(section: PlaybookSection) -> PlaybookSectionOut:
    return PlaybookSectionOut(
        id=section.id, title=section.title, icon=section.icon or "", position=section.position
    )


@router.patch("/sections/{section_id}", response_model=PlaybookSectionOut)
async def update_section(
    section_id: uuid.UUID,
    body: PlaybookSectionPatch,
    user: UserContext = Depends(require_scripts_edit),
    db: AsyncSession = Depends(get_db),
):
    """Переименовать раздел или сменить его иконку в меню."""
    section = await get_section(db, section_id)
    if body.title is not None:
        title = body.title.strip()
        if not title:
            raise HTTPException(422, "Название раздела не может быть пустым")
        section.title = title
    if body.icon is not None:
        section.icon = body.icon
    await db.commit()
    return section_out(section)


@router.delete("/sections/{section_id}", status_code=204)
async def delete_section(
    section_id: uuid.UUID,
    user: UserContext = Depends(require_scripts_edit),
    db: AsyncSession = Depends(get_db),
):
    """Удаляется только пустой раздел: вместе с ним молча ушли бы скрипты,
    которые кто-то писал и переводил на три языка."""
    section = await get_section(db, section_id)
    has_items = await db.scalar(
        select(PlaybookItem.id).where(PlaybookItem.section_id == section.id).limit(1)
    )
    if has_items:
        raise HTTPException(
            409, "В разделе есть скрипты — сначала перенесите их в другой раздел или удалите"
        )
    await db.delete(section)
    await db.commit()
    return None


@router.put("/sections/order", status_code=204)
async def reorder_sections(
    body: PlaybookOrder,
    user: UserContext = Depends(require_scripts_edit),
    db: AsyncSession = Depends(get_db),
):
    org = await current_org(db)
    sections = (
        await db.scalars(select(PlaybookSection).where(PlaybookSection.org_id == org.id))
    ).all()
    if {s.id for s in sections} != set(body.ids) or len(body.ids) != len(sections):
        # Порядок присылают целиком; расхождение значит, что раздел добавили
        # или удалили в соседней вкладке, и вслепую переставлять нельзя.
        raise HTTPException(409, "Список разделов изменился — обновите страницу")
    position = {sid: i for i, sid in enumerate(body.ids)}
    for section in sections:
        section.position = position[section.id]
    await db.commit()
    return None


@router.put("/sections/{section_id}/order", status_code=204)
async def reorder_items(
    section_id: uuid.UUID,
    body: PlaybookOrder,
    user: UserContext = Depends(require_scripts_edit),
    db: AsyncSession = Depends(get_db),
):
    section = await get_section(db, section_id)
    items = (
        await db.scalars(select(PlaybookItem).where(PlaybookItem.section_id == section.id))
    ).all()
    if {i.id for i in items} != set(body.ids) or len(body.ids) != len(items):
        raise HTTPException(409, "Список скриптов изменился — обновите страницу")
    position = {iid: i for i, iid in enumerate(body.ids)}
    for item in items:
        item.position = position[item.id]
    await db.commit()
    return None


# --- Скрипты ---

@router.post("/items", response_model=PlaybookItemOut, status_code=201)
async def create_item(
    body: PlaybookItemIn,
    user: UserContext = Depends(require_scripts_edit),
    db: AsyncSession = Depends(get_db),
):
    section = await get_section(db, body.section_id)
    item = PlaybookItem(
        org_id=section.org_id,
        section_id=section.id,
        title=body.title,
        kind=body.kind,
        keywords=body.keywords.strip(),
        note=body.note.strip(),
        follow_up=body.follow_up.strip(),
        variants=clean_variants(body),
        position=await next_position(
            db, PlaybookItem, PlaybookItem.section_id == section.id
        ),
        updated_by=author(user),
        change_note=body.change_note.strip() or "Новый скрипт",
    )
    db.add(item)
    await db.flush()
    await record(db, item, "created", user, None, await snapshot(db, item), item.change_note)
    await db.commit()
    await db.refresh(item)
    return item


@router.put("/items/{item_id}", response_model=PlaybookItemOut)
async def update_item(
    item_id: uuid.UUID,
    body: PlaybookItemIn,
    user: UserContext = Depends(require_scripts_edit),
    db: AsyncSession = Depends(get_db),
):
    note = body.change_note.strip()
    if not note:
        # Скрипт меняется у всех сразу: без пары слов «что и зачем» человек у
        # стойки увидит другой текст и не поймёт, ошибка это или так задумано.
        raise HTTPException(422, "Опишите, что изменили — это увидят все на карточке скрипта")
    item = await get_item(db, item_id)
    before = await snapshot(db, item)
    if body.section_id != item.section_id:
        # Перенесённый скрипт встаёт в конец нового раздела — там его и ищут
        # глазами сразу после переноса.
        section = await get_section(db, body.section_id)
        item.section_id = section.id
        item.position = await next_position(
            db, PlaybookItem, PlaybookItem.section_id == section.id
        )
    item.title = body.title
    item.kind = body.kind
    item.keywords = body.keywords.strip()
    item.note = body.note.strip()
    item.follow_up = body.follow_up.strip()
    item.variants = clean_variants(body)
    item.updated_at = utcnow()
    item.updated_by = author(user)
    item.change_note = note
    await record(db, item, "updated", user, before, await snapshot(db, item), note)
    await db.commit()
    await db.refresh(item)
    return item


@router.delete("/items/{item_id}", status_code=204)
async def delete_item(
    item_id: uuid.UUID,
    user: UserContext = Depends(require_scripts_edit),
    db: AsyncSession = Depends(get_db),
):
    item = await get_item(db, item_id)
    await record(db, item, "deleted", user, await snapshot(db, item), None, "Скрипт удалён")
    await db.delete(item)
    await db.commit()
    return None


# --- Настройки: студии, имена администраторов, переменные ---

def first_name(full_name: str) -> str:
    """Имя по умолчанию — первое слово: в чате пишут «Меня зовут Анна», а не
    «Анна Гелашвили»."""
    parts = full_name.split()
    return parts[0] if parts else ""


@router.get("/settings", response_model=PlaybookSettingsOut)
async def get_settings(
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Читают все вошедшие: без настроек админка не подставит в скрипт ни
    имя администратора, ни студию, ни переменные."""
    org = await current_org(db)
    row = await db.get(PlaybookSettings, org.id)
    data = (row.data if row else None) or {}
    studios = data.get("studios", {})
    admins = data.get("admins", {})

    locations = (
        await db.scalars(select(Location).order_by(Location.active.desc(), Location.name))
    ).all()
    employees = (
        await db.scalars(
            select(Employee)
            .where(Employee.active.is_(True))
            .order_by(Employee.login.is_(None), Employee.full_name)
        )
    ).all()

    def names(saved: dict | None, default_ru: str) -> dict:
        saved = saved or {}
        return {
            "ru": saved.get("ru") or default_ru,
            "en": saved.get("en", ""),
            "ka": saved.get("ka", ""),
        }

    return PlaybookSettingsOut(
        studios=[
            StudioNamesOut(
                location_id=loc.id,
                location_name=loc.name,
                active=loc.active,
                **names(studios.get(str(loc.id)), loc.name),
            )
            for loc in locations
        ],
        admins=[
            AdminNamesOut(
                employee_id=emp.id,
                full_name=emp.full_name,
                has_login=bool(emp.login),
                **names(admins.get(str(emp.id)), first_name(emp.full_name)),
            )
            for emp in employees
        ],
        variables=data.get("variables", []),
        updated_at=row.updated_at if row else None,
        updated_by=row.updated_by if row else "",
    )


@router.put("/settings", response_model=PlaybookSettingsOut)
async def save_settings(
    body: PlaybookSettingsIn,
    user: UserContext = Depends(require_scripts_edit),
    db: AsyncSession = Depends(get_db),
):
    org = await current_org(db)

    def clean(texts) -> dict:
        return {lang: getattr(texts, lang).strip() for lang in ("ru", "en", "ka")}

    data = {
        "studios": {str(k): clean(v) for k, v in body.studios.items()},
        "admins": {str(k): clean(v) for k, v in body.admins.items()},
        "variables": [
            {
                "key": v.key.strip(),
                "type": v.type,
                "description": v.description.strip(),
                # У даты текстов нет — значение считается от сегодняшнего дня.
                "ru": v.ru.strip() if v.type == "text" else "",
                "en": v.en.strip() if v.type == "text" else "",
                "ka": v.ka.strip() if v.type == "text" else "",
                "offset_days": v.offset_days if v.type == "date" else 0,
            }
            for v in body.variables
        ],
    }
    row = await db.get(PlaybookSettings, org.id)
    if row:
        row.data = data
        row.updated_at = utcnow()
        row.updated_by = author(user)
    else:
        db.add(PlaybookSettings(org_id=org.id, data=data, updated_by=author(user)))
    await db.commit()
    return await get_settings(user, db)


# --- Хронология изменений ---

PAGE = 20


@router.get("/changes", response_model=PlaybookChangesPage)
async def list_changes(
    cursor: str = "",
    limit: int = PAGE,
    user: UserContext = Depends(require_scripts_edit),
    db: AsyncSession = Depends(get_db),
):
    """Порциями, от новых к старым. Курсор — время и id последней записи
    порции: в отличие от номера страницы, он не съезжает, когда между
    порциями кто-то сохранил новую правку."""
    org = await current_org(db)
    limit = max(1, min(limit, 50))
    q = select(PlaybookChange).where(PlaybookChange.org_id == org.id)
    if cursor:
        at, row_id = decode_cursor(cursor)
        q = q.where(
            (PlaybookChange.created_at < at)
            | ((PlaybookChange.created_at == at) & (PlaybookChange.id < row_id))
        )
    rows = (
        await db.scalars(
            q.order_by(PlaybookChange.created_at.desc(), PlaybookChange.id.desc()).limit(limit + 1)
        )
    ).all()
    more = len(rows) > limit
    rows = rows[:limit]
    return PlaybookChangesPage(
        items=[PlaybookChangeOut.model_validate(r) for r in rows],
        next_cursor=encode_cursor(rows[-1].created_at, rows[-1].id) if more and rows else "",
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
    user: UserContext = Depends(require_scripts_edit),
    db: AsyncSession = Depends(get_db),
):
    org = await current_org(db)
    limit = max(1, min(limit, 50))
    seen = await seen_at(db, user)
    q = select(PlaybookSuggestion).where(PlaybookSuggestion.org_id == org.id)
    if cursor:
        at, row_id = decode_cursor(cursor)
        q = q.where(
            (PlaybookSuggestion.created_at < at)
            | ((PlaybookSuggestion.created_at == at) & (PlaybookSuggestion.id < row_id))
        )
    rows = (
        await db.scalars(
            q.order_by(PlaybookSuggestion.created_at.desc(), PlaybookSuggestion.id.desc())
            .limit(limit + 1)
        )
    ).all()
    more = len(rows) > limit
    rows = rows[:limit]
    items = []
    for r in rows:
        out = PlaybookSuggestionOut.model_validate(r)
        out.unread = r.author_key != user.author_key and (seen is None or r.created_at > seen)
        items.append(out)
    return PlaybookSuggestionsPage(
        items=items,
        next_cursor=encode_cursor(rows[-1].created_at, rows[-1].id) if more and rows else "",
    )


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
    """Сколько новых предложений этот администратор ещё не видел. Свои не
    считаются; у тех, кто скрипты только читает, — всегда ноль."""
    if not user.can_edit_scripts:
        return UnreadOut(count=0)
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
    user: UserContext = Depends(require_scripts_edit),
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
