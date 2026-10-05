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
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import UserContext, require_scripts_edit, require_user
from ..db import get_db
from ..models import (
    Organization,
    PlaybookCallFlow,
    PlaybookChange,
    PlaybookItem,
    PlaybookSection,
    PlaybookState,
    utcnow,
)
from ..schemas import (
    CallFlow,
    CallFlowIn,
    PlaybookItemIn,
    PlaybookItemOut,
    PlaybookOrder,
    PlaybookOut,
    PlaybookSectionIn,
    PlaybookSectionOut,
    PlaybookSectionPatch,
)

from .playbook_common import author, current_org, missing_migration

router = APIRouter(prefix="/api/playbook", tags=["playbook"])
log = logging.getLogger(__name__)

DEFAULT_PATH = Path(__file__).resolve().parents[1] / "playbook_default.json"
CALL_DEFAULT_PATH = Path(__file__).resolve().parents[1] / "playbook_call_default.json"


@lru_cache
def default_call_section() -> dict:
    """Стартовый раздел-звонок (холодный звонок: запись на пробное) — та же
    проверка схемой, что у правок из админки."""
    raw = json.loads(CALL_DEFAULT_PATH.read_text(encoding="utf-8"))
    return {
        "title": raw["title"],
        "icon": raw.get("icon", ""),
        "flow": CallFlow.model_validate(raw["flow"]).model_dump(),
    }


def blank_flow() -> dict:
    """Новый раздел-звонок начинается с одного блока — дальше его строят в
    редакторе сценария."""
    return CallFlow.model_validate(
        {
            "start": "start",
            "nodes": [
                {
                    "id": "start",
                    "title": "Приветствие",
                    "group": "main",
                    "text": {"ru": "{имя}, добрый день! Меня зовут {админ}, студия растяжки Lady Stretch."},
                    "answers": [],
                }
            ],
        }
    ).model_dump()


async def load_flows(db: AsyncSession, org_id) -> dict:
    """Сценарии звонков по разделам. Таблицы ещё нет (миграция 016 не
    выполнена) — звонков просто нет, текстовые скрипты работают."""
    try:
        async with db.begin_nested():
            rows = (
                await db.scalars(select(PlaybookCallFlow).where(PlaybookCallFlow.org_id == org_id))
            ).all()
        return {r.section_id: r for r in rows}
    except ProgrammingError:
        return {}


async def get_flow(db: AsyncSession, section_id) -> PlaybookCallFlow | None:
    try:
        async with db.begin_nested():
            return await db.get(PlaybookCallFlow, section_id)
    except ProgrammingError:
        return None
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
        call = default_call_section()
        call_section = PlaybookSection(
            org_id=org.id,
            title=call["title"],
            icon=call["icon"],
            position=len(default_playbook()),
        )
        db.add(call_section)
        await db.flush()
        db.add(
            PlaybookCallFlow(
                section_id=call_section.id,
                org_id=org.id,
                flow=call["flow"],
                updated_by="перенесено из документа",
                change_note="Перенесено из документа «Скрипт — ЗВОНОК»",
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
    flows = await load_flows(db, org.id)
    return PlaybookOut(
        sections=[
            section_out(s, flows.get(s.id), by_section.get(s.id, []))
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
    flow = None
    if body.kind == "call":
        # Раздел-звонок: сразу со сценарием из одного блока.
        await db.flush()
        flow = PlaybookCallFlow(
            section_id=section.id,
            org_id=org.id,
            flow=blank_flow(),
            updated_by=author(user),
            change_note="Новый сценарий звонка",
        )
        db.add(flow)
    try:
        await db.commit()
    except ProgrammingError as exc:
        await db.rollback()
        raise missing_migration("Разделы-звонки ещё не включены", "016_call_scripts.sql") from exc
    await db.refresh(section)
    return section_out(section, flow)


def section_out(
    section: PlaybookSection,
    flow: PlaybookCallFlow | None = None,
    items: list[PlaybookItemOut] | None = None,
) -> PlaybookSectionOut:
    return PlaybookSectionOut(
        id=section.id,
        title=section.title,
        icon=section.icon or "",
        position=section.position,
        kind="call" if flow else "text",
        items=items or [],
        flow=CallFlow.model_validate(flow.flow) if flow else None,
        flow_updated_at=flow.updated_at if flow else None,
        flow_updated_by=flow.updated_by if flow else "",
        flow_change_note=flow.change_note if flow else "",
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
    return section_out(section, await get_flow(db, section.id))


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


@router.put("/sections/{section_id}/flow", response_model=PlaybookSectionOut)
async def save_flow(
    section_id: uuid.UUID,
    body: CallFlowIn,
    user: UserContext = Depends(require_scripts_edit),
    db: AsyncSession = Depends(get_db),
):
    """Сохранить сценарий звонка целиком: блоки, тексты, ответы и переходы.
    Как и у текстовых скриптов — с «что изменили» и записью в хронологию."""
    section = await get_section(db, section_id)
    flow = await get_flow(db, section.id)
    if not flow:
        raise HTTPException(409, "Это раздел текстовых скриптов, а не звонок")
    note = body.change_note.strip()
    if not note:
        raise HTTPException(422, "Опишите, что изменили — это увидят в хронологии")
    data = body.flow.model_dump()
    before = {"title": section.title, "kind": "call", "section": section.title, "flow": flow.flow}
    flow.flow = data
    flow.updated_at = utcnow()
    flow.updated_by = author(user)
    flow.change_note = note
    try:
        async with db.begin_nested():
            db.add(
                PlaybookChange(
                    org_id=section.org_id,
                    item_id=section.id,
                    item_title=section.title,
                    action="updated",
                    before=before,
                    after={"title": section.title, "kind": "call", "section": section.title, "flow": data},
                    change_note=note,
                    author=author(user),
                )
            )
    except ProgrammingError:
        log.warning("Хронология звонка не записана: нет таблицы playbook_changes (миграция 013)")
    await db.commit()
    return section_out(section, flow)


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
    if await get_flow(db, section.id):
        raise HTTPException(409, "В разделе-звонке один сценарий — текстовые скрипты сюда не добавляются")
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
        if await get_flow(db, section.id):
            raise HTTPException(409, "В раздел-звонок текстовый скрипт не переносится")
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
