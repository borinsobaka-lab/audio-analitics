"""Скрипты: статистика копирований и ИИ-помощник.

Отдельно от основного роутера скриптов: это не правка скриптов, а то, что
вокруг них — сколько и чем пользуются, и подсказка ответа клиенту.
"""
import logging
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import case, func, select
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import playbook_ai
from ..auth import UserContext, require_scripts_edit, require_user
from ..config import get_settings
from ..db import get_db
from ..models import (
    PlaybookCopy,
    PlaybookItem,
    PlaybookSection,
    PlaybookSettings,
    ScriptTemplate,
)
from ..schemas import (
    AiPromptIn,
    AiPromptOut,
    AssistIn,
    AssistIssue,
    AssistMatch,
    AssistSource,
    AssistOut,
    CopyStatItem,
    CopyStatsOut,
    CopyStatUser,
    LangCounts,
    PlaybookCopyIn,
)
from ..models import utcnow
from .playbook_common import author, current_org, missing_migration

router = APIRouter(prefix="/api/playbook", tags=["playbook"])
log = logging.getLogger(__name__)


# --- Копирования ---

@router.post("/copies", status_code=204)
async def log_copy(
    body: PlaybookCopyIn,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Отметка «скопировали текст скрипта». Админка шлёт её, не дожидаясь
    ответа: копирование у стойки не должно зависеть от статистики. Поэтому
    и до миграции 015 здесь не ошибка, а тихий пропуск."""
    org = await current_org(db)
    item = await db.get(PlaybookItem, body.item_id)
    if not item or item.org_id != org.id:
        return None
    db.add(
        PlaybookCopy(
            org_id=org.id,
            item_id=item.id,
            item_title=item.title,
            user_key=user.author_key,
            user_name=author(user),
            lang=body.lang,
            studio=body.studio.strip(),
            source=body.source,
        )
    )
    try:
        await db.commit()
    except ProgrammingError:
        await db.rollback()
        log.warning("Копирование не записано: нет таблицы playbook_copies (миграция 015)")
    return None


def lang_sums():
    return (
        func.count().label("total"),
        func.sum(case((PlaybookCopy.lang == "ru", 1), else_=0)).label("ru"),
        func.sum(case((PlaybookCopy.lang == "en", 1), else_=0)).label("en"),
        func.sum(case((PlaybookCopy.lang == "ka", 1), else_=0)).label("ka"),
    )


def counts(row) -> dict:
    return {"total": row.total or 0, "ru": row.ru or 0, "en": row.en or 0, "ka": row.ka or 0}


@router.get("/stats", response_model=CopyStatsOut)
async def copy_stats(
    date_from: datetime | None = Query(None, alias="from"),
    date_to: datetime | None = Query(None, alias="to"),
    user_key: str = Query("", alias="user"),
    lang: str = "",
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Какие скрипты копируют чаще — за период, у одного администратора или
    у всех, на одном языке или на всех. Границы периода присылает админка
    уже с часовым поясом браузера: «сегодня» — это тбилисское сегодня."""
    org = await current_org(db)
    where = [PlaybookCopy.org_id == org.id]
    if date_from:
        where.append(PlaybookCopy.created_at >= date_from)
    if date_to:
        where.append(PlaybookCopy.created_at < date_to)
    if lang in ("ru", "en", "ka"):
        where.append(PlaybookCopy.lang == lang)
    # Список администраторов — без фильтра по администратору: из него
    # выбирают, кого смотреть.
    item_where = [*where, PlaybookCopy.user_key == user_key] if user_key else where

    try:
        totals = (await db.execute(select(*lang_sums()).where(*item_where))).one()
        item_rows = (
            await db.execute(
                select(
                    PlaybookCopy.item_id,
                    func.max(PlaybookCopy.item_title).label("title"),
                    *lang_sums(),
                )
                .where(*item_where)
                .group_by(PlaybookCopy.item_id)
                .order_by(func.count().desc())
            )
        ).all()
        user_rows = (
            await db.execute(
                select(
                    PlaybookCopy.user_key,
                    func.max(PlaybookCopy.user_name).label("name"),
                    *lang_sums(),
                )
                .where(*where)
                .group_by(PlaybookCopy.user_key)
                .order_by(func.count().desc())
            )
        ).all()
    except ProgrammingError as exc:
        await db.rollback()
        raise missing_migration("Статистика ещё не включена", "015_playbook_copies_ai.sql") from exc

    # Названия и разделы — текущие: скрипт могли переименовать после
    # копирований. Удалённый остаётся под последним названием.
    ids = [r.item_id for r in item_rows if r.item_id]
    live: dict[uuid.UUID, tuple[str, str]] = {}
    if ids:
        for item_id, title, section in (
            await db.execute(
                select(PlaybookItem.id, PlaybookItem.title, PlaybookSection.title)
                .join(PlaybookSection, PlaybookSection.id == PlaybookItem.section_id)
                .where(PlaybookItem.id.in_(ids))
            )
        ).all():
            live[item_id] = (title, section)

    items = []
    for r in item_rows:
        title, section = live.get(r.item_id, (r.title, ""))
        items.append(
            CopyStatItem(
                item_id=r.item_id,
                title=title,
                section=section,
                deleted=r.item_id not in live,
                **counts(r),
            )
        )
    return CopyStatsOut(
        totals=LangCounts(**counts(totals)),
        items=items,
        users=[CopyStatUser(user_key=r.user_key, name=r.name, **counts(r)) for r in user_rows],
    )


# --- ИИ-помощник ---

async def settings_data(db: AsyncSession, org_id) -> tuple[PlaybookSettings | None, dict]:
    row = await db.get(PlaybookSettings, org_id)
    return row, dict((row.data if row else None) or {})


def ai_model(data: dict) -> str:
    return (data.get("ai_model") or "").strip() or get_settings().openai_model.strip()


def ai_prompt_out(data: dict) -> AiPromptOut:
    saved = (data.get("ai_prompt") or "").strip()
    saved_verify = (data.get("ai_verify_prompt") or "").strip()
    settings = get_settings()
    return AiPromptOut(
        prompt=saved or playbook_ai.DEFAULT_PROMPT,
        default_prompt=playbook_ai.DEFAULT_PROMPT,
        is_default=not saved or saved == playbook_ai.DEFAULT_PROMPT.strip(),
        verify_prompt=saved_verify or playbook_ai.DEFAULT_VERIFY_PROMPT,
        default_verify_prompt=playbook_ai.DEFAULT_VERIFY_PROMPT,
        verify_is_default=not saved_verify
        or saved_verify == playbook_ai.DEFAULT_VERIFY_PROMPT.strip(),
        model=ai_model(data),
        model_saved=(data.get("ai_model") or "").strip(),
        model_default=settings.openai_model.strip(),
        configured=bool(settings.openai_api_key),
    )


@router.get("/ai", response_model=AiPromptOut)
async def get_ai_prompt(
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    org = await current_org(db)
    _, data = await settings_data(db, org.id)
    return ai_prompt_out(data)


@router.put("/ai", response_model=AiPromptOut)
async def save_ai_prompt(
    body: AiPromptIn,
    user: UserContext = Depends(require_scripts_edit),
    db: AsyncSession = Depends(get_db),
):
    """Промпт и модель хранятся в настройках скриптов рядом с переменными.
    Пустой или совпадающий со стандартным промпт — значит «стандартный»:
    тогда его улучшения в новых версиях приходят сами. Пустая модель —
    модель с сервера (OPENAI_MODEL)."""
    org = await current_org(db)
    row, data = await settings_data(db, org.id)
    prompt = body.prompt.strip()
    if prompt == playbook_ai.DEFAULT_PROMPT.strip():
        prompt = ""
    data["ai_prompt"] = prompt
    verify = body.verify_prompt.strip()
    if verify == playbook_ai.DEFAULT_VERIFY_PROMPT.strip():
        verify = ""
    data["ai_verify_prompt"] = verify
    data["ai_model"] = body.model.strip()
    if row:
        row.data = data
        row.updated_at = utcnow()
        row.updated_by = author(user)
    else:
        db.add(PlaybookSettings(org_id=org.id, data=data, updated_by=author(user)))
    await db.commit()
    return ai_prompt_out(data)


def variables_hint(data: dict) -> str:
    lines = ["{админ} — имя администратора", "{студия} — название студии"]
    for v in data.get("variables", []):
        key = (v.get("key") or "").strip()
        if not key:
            continue
        desc = (v.get("description") or "").strip()
        if v.get("type") == "date":
            desc = desc or f"дата через {v.get('offset_days', 0)} дн. от сегодня"
        else:
            value = (v.get("ru") or "").strip()
            desc = f"{desc} (сейчас: {value})" if value and desc else (desc or value)
        lines.append(f"{{{key}}} — {desc}" if desc else f"{{{key}}}")
    return "\n".join(lines)


@router.post("/assist", response_model=AssistOut)
async def assist(
    body: AssistIn,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    org = await current_org(db)
    _, data = await settings_data(db, org.id)

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
    by_section: dict = {}
    for item in items:
        by_section.setdefault(item.section_id, []).append(item)
    tree = [
        {
            "title": sec.title,
            "items": [
                {
                    "id": str(it.id),
                    "title": it.title,
                    "kind": it.kind,
                    "note": it.note,
                    "follow_up": it.follow_up,
                    "variants": it.variants,
                }
                for it in by_section.get(sec.id, [])
            ],
        }
        for sec in sections
    ]
    known = {it.id: (it, next((s.title for s in sections if s.id == it.section_id), "")) for it in items}

    script = await db.scalar(
        select(ScriptTemplate)
        .where(ScriptTemplate.org_id == org.id, ScriptTemplate.active.is_(True))
        .order_by(ScriptTemplate.version.desc())
    )

    try:
        result = await playbook_ai.ask(
            model=ai_model(data),
            prompt=(data.get("ai_prompt") or "").strip() or playbook_ai.DEFAULT_PROMPT,
            verify_prompt=(data.get("ai_verify_prompt") or "").strip()
            or playbook_ai.DEFAULT_VERIFY_PROMPT,
            catalog=playbook_ai.build_catalog(tree),
            sales_rules=playbook_ai.build_sales_rules(
                {"stages": script.stages_json, "body": script.body} if script else None
            ),
            variables=variables_hint(data),
            studio=body.studio,
            lang=body.lang,
            message=body.message,
        )
    except playbook_ai.AssistError as exc:
        raise HTTPException(502, str(exc)) from exc

    # Только скрипты, которые действительно есть: id из ответа ИИ не
    # принимается на веру.
    matches: list[AssistMatch] = []
    for m in result.get("matches") or []:
        try:
            item_id = uuid.UUID(str(m.get("script_id", "")))
        except ValueError:
            continue
        if item_id in known and all(x.item_id != item_id for x in matches):
            it, section = known[item_id]
            matches.append(
                AssistMatch(item_id=it.id, title=it.title, section=section, why=str(m.get("why", "")))
            )
        if len(matches) == 3:
            break

    sources: list[AssistSource] = []
    for raw in result.get("used_sources") or []:
        key = str(raw).strip()
        if key == "sales_rules":
            sources.append(AssistSource(title="Правила продаж (скрипт продаж «Аналитики»)"))
            continue
        if key == "variables":
            sources.append(AssistSource(title="Переменные из «Подстановки»"))
            continue
        try:
            item_id = uuid.UUID(key)
        except ValueError:
            continue
        if item_id in known and all(x.item_id != item_id for x in sources):
            it, section = known[item_id]
            sources.append(AssistSource(item_id=it.id, title=it.title, section=section))

    language = result.get("language") if result.get("language") in ("ru", "en", "ka") else body.lang
    return AssistOut(
        status=result.get("status", "ready"),
        language=language,
        matches=matches,
        reply=str(result.get("reply") or "").strip(),
        verified=bool(result.get("verified")),
        attempts=int(result.get("attempts") or 1),
        sources=sources if result.get("reply") else [],
        missing_information=str(result.get("missing_information") or "").strip(),
        issues=[AssistIssue(**i) for i in result.get("issues") or []],
        comment=str(result.get("comment") or "").strip(),
    )
