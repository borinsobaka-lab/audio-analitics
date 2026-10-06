"""Продукт «CRM»: настройки, критерии оценки, разборы дней и сделок.

Данные приходят из CRM через ключ интеграции (crm_ingest.py), разбор делает
воркер (pipeline/crm_tasks.py), статистика за период — crm_stats.py. Здесь —
то, что видит и настраивает человек: промпт и правила воронки, критерии,
список разборов по дням, отчёт дня и карточка сделки с перепиской.
"""
import secrets
import uuid
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession

import asyncio

from .. import crm_ai, crm_notify, crm_scheduler
from ..auth import UserContext, require_crm_manage, require_user
from ..config import get_settings
from ..db import get_db
from ..models import (
    CrmCriterion,
    CrmDeal,
    CrmEvent,
    CrmMessage,
    CrmReview,
    CrmReviewScore,
    CrmRun,
    CrmSettings,
    Employee,
    Organization,
    utcnow,
)
from ..schemas import (
    CrmCriterionCreate,
    CrmCriterionOut,
    CrmCriterionUpdate,
    CrmDealOut,
    CrmEventOut,
    CrmManagerOut,
    CrmMessageOut,
    CrmNotifyOut,
    CrmPipelineRef,
    CrmStageRef,
    CrmPipelineCheck,
    CrmProblem,
    CrmReviewDetailOut,
    CrmReviewOut,
    CrmRunOut,
    CrmRunReportOut,
    CrmRunsOut,
    CrmScoreOut,
    CrmScriptsCheck,
    CrmSettingsIn,
    CrmSettingsOut,
)
from .playbook_common import author, current_org, missing_migration

router = APIRouter(prefix="/api/crm", tags=["crm"])

MIGRATION = "018_crm.sql"
IN_FLIGHT = ("queued", "processing")
DEFAULT_TZ = "Asia/Tbilisi"
# Сколько дней назад искать неразобранные дни с данными.
PENDING_DAYS = 30
SEVERITY_ORDER = {"critical": 0, "warning": 1, "ok": 2}


# --- Общее ----------------------------------------------------------------


def tz_of(data: dict) -> ZoneInfo:
    try:
        return ZoneInfo((data.get("timezone") or "").strip() or DEFAULT_TZ)
    except Exception:  # noqa: BLE001
        return ZoneInfo(DEFAULT_TZ)


def end_hour_of(data: dict) -> int:
    return crm_scheduler.run_hour_of(data)


def current_day(data: dict) -> date:
    """Отчётный день, который идёт сейчас: при часе 20 после 20:00 это уже
    завтрашняя дата — сегодняшний день закрыт и разобран."""
    return crm_ai.report_day(datetime.now(timezone.utc), tz_of(data), end_hour_of(data))


async def settings_data(db: AsyncSession, org_id) -> tuple[CrmSettings | None, dict]:
    try:
        row = await db.get(CrmSettings, org_id)
    except ProgrammingError as exc:
        await db.rollback()
        raise missing_migration("CRM ещё не включена", MIGRATION) from exc
    return row, dict((row.data if row else None) or {})


async def save_data(
    db: AsyncSession, org: Organization, row: CrmSettings | None, data: dict, who: str
) -> None:
    """Сохранить настройки, не трогая раздел amoCRM: его пишет синхронизация,
    и токен OAuth, обновлённый ею секунду назад, нельзя затереть старым."""
    if row:
        await db.refresh(row)
        fresh_amo = (row.data or {}).get("amo")
        merged = dict(data)
        if fresh_amo is not None:
            merged["amo"] = fresh_amo
        row.data = merged
        row.updated_at = utcnow()
        row.updated_by = who
    else:
        db.add(CrmSettings(org_id=org.id, data=data, updated_by=who))
    await db.commit()


def is_stale(run: CrmRun) -> bool:
    """Разбор числится идущим, но статус давно не двигался — воркер его потерял."""
    if run.status not in IN_FLIGHT:
        return False
    changed = run.status_changed_at or run.created_at
    if changed is None:
        return True
    if changed.tzinfo is None:
        changed = changed.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - changed > timedelta(
        seconds=get_settings().stale_processing_s
    )


def run_out(run: CrmRun, reviews_done: int | None = None, problems: int | None = None) -> CrmRunOut:
    return CrmRunOut(
        id=run.id,
        date=run.date,
        status=run.status,
        status_detail=run.status_detail,
        stale=is_stale(run),
        trigger=run.trigger,
        deals_total=run.deals_total,
        reviews_done=run.reviews_done if reviews_done is None else reviews_done,
        problems_count=run.problems_count if problems is None else problems,
        llm_input_tokens=run.llm_input_tokens,
        llm_output_tokens=run.llm_output_tokens,
        llm_calls=run.llm_calls,
        cost_usd=run.cost_usd,
        created_at=run.created_at,
        finished_at=run.finished_at,
    )


def scope_reviews(q, user: UserContext):
    """Сотрудник с правом «свои сделки» видит разборы сделок, которые вёл
    сам; чужие для него не существуют."""
    if user.can_view_all_crm:
        return q
    if not user.employee_id:
        return q.where(CrmReview.id.is_(None))
    return q.where(CrmReview.employee_id == user.employee_id)


async def employees_index(db: AsyncSession, org_id) -> list[dict]:
    return [
        {"id": e.id, "full_name": e.full_name}
        for e in (await db.scalars(select(Employee).where(Employee.org_id == org_id))).all()
    ]


# --- Настройки ------------------------------------------------------------


async def known_managers(db: AsyncSession, org_id, data: dict) -> list[CrmManagerOut]:
    """Менеджеры, встретившиеся в данных: ответственные по сделкам и авторы
    исходящих сообщений. Для сопоставления с сотрудниками админки."""
    seen: dict[str, dict] = {}
    for key, name, deals in (
        await db.execute(
            select(CrmDeal.manager_key, func.max(CrmDeal.manager_name), func.count())
            .where(CrmDeal.org_id == org_id, CrmDeal.manager_key != "")
            .group_by(CrmDeal.manager_key)
        )
    ).all():
        seen[key] = {"name": name or "", "deals": int(deals or 0)}
    for key, name, deals in (
        await db.execute(
            select(
                CrmMessage.author_key,
                func.max(CrmMessage.author_name),
                func.count(func.distinct(CrmMessage.deal_id)),
            )
            .where(
                CrmMessage.org_id == org_id,
                CrmMessage.direction == "out",
                CrmMessage.author_key != "",
            )
            .group_by(CrmMessage.author_key)
        )
    ).all():
        entry = seen.setdefault(key, {"name": "", "deals": 0})
        entry["name"] = entry["name"] or (name or "")
        entry["deals"] = max(entry["deals"], int(deals or 0))
    employees = await employees_index(db, org_id)
    manager_map = data.get("manager_map") or {}
    out = []
    for key, entry in sorted(seen.items(), key=lambda kv: (-kv[1]["deals"], kv[1]["name"])):
        out.append(
            CrmManagerOut(
                key=key,
                name=entry["name"],
                deals=entry["deals"],
                employee_id=crm_ai.resolve_employee(key, entry["name"], manager_map, employees),
                mapped=bool(manager_map.get(key)),
            )
        )
    return out


async def known_pipelines(db: AsyncSession, org_id, data: dict) -> list[CrmPipelineRef]:
    """Воронки и этапы для выбора «что не разбирать»: из словарей amoCRM (в
    их порядке) и из сделок, которые уже пришли."""
    order: dict[str, list[str]] = {}
    dicts = (data.get("amo") or {}).get("dicts") or {}
    for pid, name in (dicts.get("pipelines") or {}).items():
        stages = order.setdefault(name, [])
        for s in (dicts.get("statuses") or {}).values():
            if s.get("pipeline_id") == pid and s.get("name") and s["name"] not in stages:
                stages.append(s["name"])
    rows = (
        await db.execute(
            select(CrmDeal.pipeline, CrmDeal.stage)
            .where(CrmDeal.org_id == org_id)
            .group_by(CrmDeal.pipeline, CrmDeal.stage)
        )
    ).all()
    for pipeline, stage in rows:
        stages = order.setdefault(pipeline or "", [])
        if stage and stage not in stages:
            stages.append(stage)
    return [CrmPipelineRef(name=name, stages=stages) for name, stages in order.items() if name or stages]


def settings_out(
    data: dict,
    managers: list[CrmManagerOut],
    row: CrmSettings | None,
    pipelines: list[CrmPipelineRef] | None = None,
) -> CrmSettingsOut:
    settings = get_settings()
    hours = crm_ai.work_hours_of(data, tz_of(data))
    prompt = (data.get("prompt") or "").strip()
    summary = (data.get("summary_prompt") or "").strip()
    rules = (data.get("pipeline_rules") or "").strip()
    saved_model = (data.get("model") or "").strip()
    manager_map = {}
    for key, value in (data.get("manager_map") or {}).items():
        try:
            manager_map[str(key)] = uuid.UUID(str(value)) if value else None
        except ValueError:
            continue
    return CrmSettingsOut(
        prompt=prompt or crm_ai.DEFAULT_PROMPT,
        default_prompt=crm_ai.DEFAULT_PROMPT,
        is_default=not prompt or prompt == crm_ai.DEFAULT_PROMPT.strip(),
        summary_prompt=summary or crm_ai.DEFAULT_SUMMARY_PROMPT,
        default_summary_prompt=crm_ai.DEFAULT_SUMMARY_PROMPT,
        summary_is_default=not summary or summary == crm_ai.DEFAULT_SUMMARY_PROMPT.strip(),
        pipeline_rules=rules or crm_ai.DEFAULT_PIPELINE_RULES,
        default_pipeline_rules=crm_ai.DEFAULT_PIPELINE_RULES,
        pipeline_is_default=not rules or rules == crm_ai.DEFAULT_PIPELINE_RULES.strip(),
        model=saved_model or settings.llm_model_stage2,
        model_saved=saved_model,
        model_default=settings.llm_model_stage2,
        timezone=(data.get("timezone") or "").strip() or DEFAULT_TZ,
        auto_run=bool(data.get("auto_run", True)),
        run_hour=crm_scheduler.run_hour_of(data),
        max_deals=int(data.get("max_deals") or 400),
        work_start=crm_ai.fmt_hhmm(hours.start),
        work_end=crm_ai.fmt_hhmm(hours.end),
        work_days=sorted(hours.days),
        slow_reply_minutes=int(data.get("slow_reply_minutes") or crm_ai.DEFAULT_SLOW_REPLY_MINUTES),
        exclude_pipelines=[str(x) for x in data.get("exclude_pipelines") or []],
        exclude_stages=[
            CrmStageRef(pipeline=str(x.get("pipeline") or ""), stage=str(x.get("stage")))
            for x in data.get("exclude_stages") or []
            if isinstance(x, dict) and x.get("stage")
        ],
        exclude_managers=[str(x) for x in data.get("exclude_managers") or []],
        known_pipelines=pipelines or [],
        integration_key=data.get("integration_key") or "",
        ingest_url=f"{settings.api_base_url.rstrip('/')}/api/crm/ingest",
        manager_map=manager_map,
        known_managers=managers,
        configured=bool(settings.anthropic_api_key),
        telegram_configured=crm_notify.configured(),
        dashboard_url=crm_notify.dashboard_base(),
        updated_at=row.updated_at if row else None,
        updated_by=row.updated_by if row else "",
    )


@router.get("/settings", response_model=CrmSettingsOut)
async def get_crm_settings(
    user: UserContext = Depends(require_crm_manage),
    db: AsyncSession = Depends(get_db),
):
    org = await current_org(db)
    row, data = await settings_data(db, org.id)
    if not data.get("integration_key"):
        # Ключ появляется при первом открытии настроек: его копируют в CRM
        # или в сценарий n8n/Make, чтобы данные начали приходить.
        data["integration_key"] = secrets.token_urlsafe(32)
        await save_data(db, org, row, data, author(user))
        row, data = await settings_data(db, org.id)
    return settings_out(
        data, await known_managers(db, org.id, data), row, await known_pipelines(db, org.id, data)
    )


@router.put("/settings", response_model=CrmSettingsOut)
async def save_crm_settings(
    body: CrmSettingsIn,
    user: UserContext = Depends(require_crm_manage),
    db: AsyncSession = Depends(get_db),
):
    """Промпт, совпадающий со стандартным, хранится как пустой — тогда его
    улучшения в новых версиях приходят сами. То же с правилами воронки и
    промптом итога."""
    org = await current_org(db)
    row, data = await settings_data(db, org.id)

    def keep(text: str, default: str) -> str:
        text = text.strip()
        return "" if text == default.strip() else text

    sent = body.model_fields_set
    if "prompt" in sent:
        data["prompt"] = keep(body.prompt, crm_ai.DEFAULT_PROMPT)
    if "summary_prompt" in sent:
        data["summary_prompt"] = keep(body.summary_prompt, crm_ai.DEFAULT_SUMMARY_PROMPT)
    if "pipeline_rules" in sent:
        data["pipeline_rules"] = keep(body.pipeline_rules, crm_ai.DEFAULT_PIPELINE_RULES)
    if "model" in sent:
        data["model"] = body.model.strip()
    for key in (
        "timezone", "auto_run", "run_hour", "max_deals", "work_start", "work_end",
        "work_days", "slow_reply_minutes", "exclude_managers",
    ):
        if key in sent:
            data[key] = getattr(body, key)
    if "exclude_pipelines" in sent:
        data["exclude_pipelines"] = [p.strip() for p in body.exclude_pipelines if p.strip()]
    if "exclude_stages" in sent:
        data["exclude_stages"] = [
            {"pipeline": s.pipeline.strip(), "stage": s.stage.strip()} for s in body.exclude_stages
        ]
    if "manager_map" in sent:
        data["manager_map"] = {k: str(v) for k, v in body.manager_map.items() if v}
    await save_data(db, org, row, data, author(user))
    row, data = await settings_data(db, org.id)
    return settings_out(
        data, await known_managers(db, org.id, data), row, await known_pipelines(db, org.id, data)
    )


@router.post("/settings/rotate-key", response_model=CrmSettingsOut)
async def rotate_integration_key(
    user: UserContext = Depends(require_crm_manage),
    db: AsyncSession = Depends(get_db),
):
    """Новый ключ: прежний перестаёт работать сразу — его надо заменить в CRM."""
    org = await current_org(db)
    row, data = await settings_data(db, org.id)
    data["integration_key"] = secrets.token_urlsafe(32)
    await save_data(db, org, row, data, author(user))
    row, data = await settings_data(db, org.id)
    return settings_out(
        data, await known_managers(db, org.id, data), row, await known_pipelines(db, org.id, data)
    )


# --- Критерии -------------------------------------------------------------


@router.get("/criteria", response_model=list[CrmCriterionOut])
async def list_criteria(
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    org = await current_org(db)
    try:
        return (
            await db.scalars(
                select(CrmCriterion)
                .where(CrmCriterion.org_id == org.id)
                .order_by(CrmCriterion.position, CrmCriterion.created_at)
            )
        ).all()
    except ProgrammingError as exc:
        await db.rollback()
        raise missing_migration("CRM ещё не включена", MIGRATION) from exc


@router.post("/criteria", response_model=CrmCriterionOut, status_code=201)
async def create_criterion(
    body: CrmCriterionCreate,
    user: UserContext = Depends(require_crm_manage),
    db: AsyncSession = Depends(get_db),
):
    org = await current_org(db)
    last = await db.scalar(
        select(func.max(CrmCriterion.position)).where(CrmCriterion.org_id == org.id)
    )
    criterion = CrmCriterion(
        org_id=org.id,
        name=body.name.strip(),
        prompt=body.prompt.strip(),
        scale_max=body.scale_max,
        active=True,
        position=(last or 0) + 1,
    )
    db.add(criterion)
    await db.commit()
    await db.refresh(criterion)
    return criterion


@router.patch("/criteria/{criterion_id}", response_model=CrmCriterionOut)
async def update_criterion(
    criterion_id: uuid.UUID,
    body: CrmCriterionUpdate,
    user: UserContext = Depends(require_crm_manage),
    db: AsyncSession = Depends(get_db),
):
    criterion = await db.get(CrmCriterion, criterion_id)
    if not criterion:
        raise HTTPException(404, "Критерий не найден")
    if body.name is not None:
        criterion.name = body.name.strip()
    if body.prompt is not None:
        criterion.prompt = body.prompt.strip()
    if body.scale_max is not None:
        criterion.scale_max = body.scale_max
    if body.active is not None:
        criterion.active = body.active
    if body.position is not None:
        criterion.position = body.position
    await db.commit()
    await db.refresh(criterion)
    return criterion


@router.delete("/criteria/{criterion_id}", status_code=204)
async def delete_criterion(
    criterion_id: uuid.UUID,
    user: UserContext = Depends(require_crm_manage),
    db: AsyncSession = Depends(get_db),
):
    """Удаление уносит и оценки по критерию в прошлых разборах; чтобы
    сохранить историю, критерий отключают."""
    criterion = await db.get(CrmCriterion, criterion_id)
    if not criterion:
        raise HTTPException(404, "Критерий не найден")
    await db.execute(delete(CrmReviewScore).where(CrmReviewScore.criterion_id == criterion_id))
    await db.delete(criterion)
    await db.commit()
    return None


# --- Разборы по дням ------------------------------------------------------


async def activity_dates(
    db: AsyncSession, org_id, tz_name: str, since: date, end_hour: int = 0
) -> set[date]:
    """Отчётные дни, в которые в CRM что-то происходило. При часе окончания
    20:00 событие в 21:00 относится к следующему дню — сдвиг на 24−20 часов."""
    days: set[date] = set()
    shift = (24 - end_hour) % 24
    for model in (CrmMessage, CrmEvent):
        local = func.timezone(tz_name, model.at)
        if shift:
            local = local + timedelta(hours=shift)
        local_day = func.date(local)
        rows = await db.execute(
            select(local_day)
            .where(model.org_id == org_id, model.at >= datetime.combine(since, datetime.min.time(), tzinfo=timezone.utc) - timedelta(days=1))
            .group_by(local_day)
        )
        for (day,) in rows.all():
            if day is not None:
                days.add(day if isinstance(day, date) else date.fromisoformat(str(day)))
    return {d for d in days if d >= since}


@router.get("/runs", response_model=CrmRunsOut)
async def list_runs(
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    org = await current_org(db)
    _, data = await settings_data(db, org.id)
    tz = tz_of(data)
    hour = end_hour_of(data)
    today = current_day(data)
    try:
        runs = (
            await db.scalars(
                select(CrmRun).where(CrmRun.org_id == org.id).order_by(CrmRun.date.desc()).limit(120)
            )
        ).all()
        has_data = (
            await db.scalar(select(CrmDeal.id).where(CrmDeal.org_id == org.id).limit(1))
        ) is not None
    except ProgrammingError as exc:
        await db.rollback()
        raise missing_migration("CRM ещё не включена", MIGRATION) from exc

    counts: dict = {}
    if not user.can_view_all_crm:
        # Свои цифры: сколько разобрано именно его сделок и сколько из них
        # проблемных, а не итоги всей студии.
        if user.employee_id and runs:
            rows = await db.execute(
                select(
                    CrmReview.run_id,
                    func.count(),
                    func.count().filter(CrmReview.problem.is_(True)),
                )
                .where(
                    CrmReview.run_id.in_([r.id for r in runs]),
                    CrmReview.employee_id == user.employee_id,
                )
                .group_by(CrmReview.run_id)
            )
            counts = {run_id: (int(n), int(p)) for run_id, n, p in rows.all()}
        out_runs = [run_out(r, *counts.get(r.id, (0, 0))) for r in runs]
    else:
        out_runs = [run_out(r) for r in runs]

    pending: list[date] = []
    if user.can_manage_crm:
        since = today - timedelta(days=PENDING_DAYS)
        done = {r.date for r in runs}
        active = await activity_dates(db, org.id, str(tz), since, hour)
        pending = sorted((d for d in active if d < today and d not in done), reverse=True)

    return CrmRunsOut(
        runs=out_runs, pending_dates=pending, has_data=has_data, today=today, day_end_hour=hour
    )


@router.post("/runs/{day}", response_model=CrmRunOut)
async def start_run(
    day: date,
    user: UserContext = Depends(require_crm_manage),
    db: AsyncSession = Depends(get_db),
):
    """Разобрать день — или разобрать заново: прошлый разбор заменяется."""
    org = await current_org(db)
    _, data = await settings_data(db, org.id)
    today = current_day(data)
    if day > today:
        raise HTTPException(400, "Этот отчётный день ещё не наступил")
    if day < today - timedelta(days=366):
        raise HTTPException(400, "Разбор доступен за последний год")

    run = await db.scalar(select(CrmRun).where(CrmRun.org_id == org.id, CrmRun.date == day))
    if run and run.status in IN_FLIGHT and not is_stale(run):
        raise HTTPException(409, "Этот день уже разбирается")
    if run:
        await db.execute(delete(CrmReview).where(CrmReview.run_id == run.id))
        run.trigger = "manual"
        run.deals_total = 0
        run.reviews_done = 0
        run.problems_count = 0
        kept = (run.summary_json or {}).get("amo_tasks")
        run.summary_json = {"amo_tasks": kept} if kept else None
        run.finished_at = None
        run.cost_usd = None
        run.llm_input_tokens = run.llm_output_tokens = run.llm_calls = 0
        run.set_status("queued", "")
    else:
        run = CrmRun(org_id=org.id, date=day, status="queued", trigger="manual")
        db.add(run)
    await db.commit()
    await db.refresh(run)
    try:
        crm_scheduler.enqueue(run.id)
    except Exception as e:  # noqa: BLE001 — честно сказать
        run.set_status("error", f"не удалось запустить разбор: {e}")
        await db.commit()
        raise HTTPException(503, f"Разбор не запустился: {e}") from e
    return run_out(run)


@router.post("/runs/{day}/notify", response_model=CrmNotifyOut)
async def notify_run(
    day: date,
    user: UserContext = Depends(require_crm_manage),
    db: AsyncSession = Depends(get_db),
):
    """Отправить сводку по разбору в Telegram руками — по расписанию она
    уходит сама."""
    org = await current_org(db)
    _, data = await settings_data(db, org.id)
    run = await db.scalar(select(CrmRun).where(CrmRun.org_id == org.id, CrmRun.date == day))
    if not run:
        raise HTTPException(404, "Разбор за этот день не найден")
    if run.status != "done":
        raise HTTPException(409, "Разбор ещё не готов")
    summary = dict(run.summary_json or {})
    stats = summary.pop("stats", None) or {}
    hour = end_hour_of(data)
    text = crm_notify.build_message(
        day=run.date,
        stats=stats,
        summary=summary,
        url=crm_notify.day_url(run.date),
        window=crm_ai.day_label(run.date, hour) if hour else "",
    )
    try:
        delivered = await asyncio.to_thread(crm_notify.send, text)
    except crm_notify.NotifyError as exc:
        raise HTTPException(502, str(exc)) from exc
    return CrmNotifyOut(delivered=delivered, chats=len(crm_notify.chat_ids()), preview=text)


@router.post("/notify/test", response_model=CrmNotifyOut)
async def notify_test(user: UserContext = Depends(require_crm_manage)):
    """Проверка бота и чата: пробное сообщение."""
    url = crm_notify.dashboard_base()
    text = (
        "<b>CRM — проверка связи</b>\nСюда будет приходить сводка разбора переписок: "
        "сколько сделок разобрано, сколько с замечаниями, на что обратить внимание."
        + (f'\n<a href="{url}/crm">Открыть CRM</a>' if url else "")
    )
    try:
        delivered = await asyncio.to_thread(crm_notify.send, text)
    except crm_notify.NotifyError as exc:
        raise HTTPException(502, str(exc)) from exc
    return CrmNotifyOut(delivered=delivered, chats=len(crm_notify.chat_ids()), preview=text)


@router.delete("/runs/{day}", status_code=204)
async def delete_run(
    day: date,
    user: UserContext = Depends(require_crm_manage),
    db: AsyncSession = Depends(get_db),
):
    org = await current_org(db)
    run = await db.scalar(select(CrmRun).where(CrmRun.org_id == org.id, CrmRun.date == day))
    if not run:
        raise HTTPException(404, "Разбор не найден")
    if run.status in IN_FLIGHT and not is_stale(run):
        raise HTTPException(409, "Этот день сейчас разбирается")
    await db.execute(delete(CrmReview).where(CrmReview.run_id == run.id))
    await db.delete(run)
    await db.commit()
    return None


def review_out(
    review: CrmReview,
    deal: CrmDeal,
    employee_name: str,
    scores: list[CrmReviewScore],
    criteria: dict,
) -> CrmReviewOut:
    scripts = review.scripts_json or {}
    pipeline = review.pipeline_json or {}
    return CrmReviewOut(
        id=review.id,
        run_id=review.run_id,
        date=review.date,
        deal=CrmDealOut.model_validate(deal),
        employee_id=review.employee_id,
        employee_name=employee_name,
        manager_key=review.manager_key,
        manager_name=review.manager_name,
        category=review.category if review.category in crm_ai.CATEGORIES else "other",
        severity=review.severity if review.severity in crm_ai.SEVERITIES else "ok",
        problem=review.problem,
        summary=review.summary,
        problems=[
            CrmProblem(
                kind=p.get("kind") if p.get("kind") in crm_ai.PROBLEM_KINDS else "chat",
                text=str(p.get("text") or ""),
                quote=str(p.get("quote") or ""),
            )
            for p in (review.problems_json or [])
            if isinstance(p, dict) and p.get("text")
        ],
        good=[str(x) for x in (review.good_json or [])],
        recommendations=[str(x) for x in (review.recommendations_json or [])],
        scripts=CrmScriptsCheck(
            used=[str(x) for x in (scripts.get("used") or [])],
            deviations=[str(x) for x in (scripts.get("deviations") or [])],
        ),
        pipeline=CrmPipelineCheck(
            ok=bool(pipeline.get("ok", True)),
            expected_stage=str(pipeline.get("expected_stage") or ""),
            comment=str(pipeline.get("comment") or ""),
        ),
        messages_in=review.messages_in,
        messages_out=review.messages_out,
        events_count=review.events_count,
        first_reply_minutes=review.first_reply_minutes,
        max_reply_minutes=review.max_reply_minutes,
        unanswered=review.unanswered,
        scores=[
            CrmScoreOut(
                criterion_id=s.criterion_id,
                name=criteria[s.criterion_id].name if s.criterion_id in criteria else "",
                scale_max=criteria[s.criterion_id].scale_max if s.criterion_id in criteria else 10,
                applicable=s.applicable,
                score=s.score,
                comment=s.comment,
            )
            for s in sorted(
                scores,
                key=lambda s: criteria[s.criterion_id].position if s.criterion_id in criteria else 999,
            )
        ],
    )


async def load_reviews(db: AsyncSession, reviews: list[CrmReview]) -> list[CrmReviewOut]:
    if not reviews:
        return []
    deals = {
        d.id: d
        for d in (
            await db.scalars(select(CrmDeal).where(CrmDeal.id.in_({r.deal_id for r in reviews})))
        ).all()
    }
    employees = {
        e.id: e.full_name
        for e in (await db.scalars(select(Employee))).all()
    }
    criteria = {c.id: c for c in (await db.scalars(select(CrmCriterion))).all()}
    scores: dict = {}
    for s in (
        await db.scalars(
            select(CrmReviewScore).where(CrmReviewScore.review_id.in_([r.id for r in reviews]))
        )
    ).all():
        scores.setdefault(s.review_id, []).append(s)
    out = []
    for r in reviews:
        deal = deals.get(r.deal_id)
        if not deal:
            continue
        out.append(
            review_out(
                r, deal, employees.get(r.employee_id, "") if r.employee_id else "", scores.get(r.id, []), criteria
            )
        )
    out.sort(key=lambda x: (SEVERITY_ORDER.get(x.severity, 3), x.manager_name, x.deal.title))
    return out


@router.get("/runs/{day}", response_model=CrmRunReportOut)
async def run_report(
    day: date,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    org = await current_org(db)
    try:
        run = await db.scalar(select(CrmRun).where(CrmRun.org_id == org.id, CrmRun.date == day))
    except ProgrammingError as exc:
        await db.rollback()
        raise missing_migration("CRM ещё не включена", MIGRATION) from exc
    if not run:
        raise HTTPException(404, "Разбор за этот день не найден")
    reviews = (
        await db.scalars(scope_reviews(select(CrmReview).where(CrmReview.run_id == run.id), user))
    ).all()
    out = await load_reviews(db, reviews)
    criteria = (
        await db.scalars(
            select(CrmCriterion)
            .where(CrmCriterion.org_id == org.id)
            .order_by(CrmCriterion.position, CrmCriterion.created_at)
        )
    ).all()
    summary = dict(run.summary_json or {})
    stats = summary.pop("stats", None)
    amo_tasks = {str(k): str(v) for k, v in (summary.pop("amo_tasks", None) or {}).items()}
    amo_tasks_error = str(summary.pop("amo_tasks_error", "") or "")
    if not user.can_view_all_crm:
        # Итог дня говорит обо всех администраторах — его видит тот, кому
        # открыты все сделки. Свои разборы сотрудник видит и так.
        summary, stats = {}, None
    counts = (len(out), sum(1 for r in out if r.problem)) if not user.can_view_all_crm else (None, None)
    _, data = await settings_data(db, org.id)
    hour = end_hour_of(data)
    window_from, window_to = crm_ai.day_bounds(run.date, tz_of(data), hour)
    return CrmRunReportOut(
        run=run_out(run, *counts),
        summary=summary or None,
        stats=stats,
        reviews=out,
        criteria=list(criteria),
        window_from=window_from,
        window_to=window_to,
        day_end_hour=hour,
        telegram_configured=crm_notify.configured() if user.can_manage_crm else False,
        slow_reply_minutes=int(data.get("slow_reply_minutes") or crm_ai.DEFAULT_SLOW_REPLY_MINUTES),
        work_hours=crm_ai.describe_hours(crm_ai.work_hours_of(data, tz_of(data))),
        amo_connected=bool((data.get("amo") or {}).get("access_token")) and user.can_manage_crm,
        amo_tasks=amo_tasks,
        amo_tasks_error=amo_tasks_error if user.can_manage_crm else "",
    )


@router.get("/reviews/{review_id}", response_model=CrmReviewDetailOut)
async def review_detail(
    review_id: uuid.UUID,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Разбор сделки с перепиской и событиями: день целиком и контекст до него."""
    org = await current_org(db)
    try:
        review = await db.scalar(
            scope_reviews(select(CrmReview).where(CrmReview.id == review_id), user)
        )
    except ProgrammingError as exc:
        await db.rollback()
        raise missing_migration("CRM ещё не включена", MIGRATION) from exc
    if not review or review.org_id != org.id:
        raise HTTPException(404, "Разбор не найден")
    (base,) = await load_reviews(db, [review])
    _, data = await settings_data(db, org.id)
    day_start, day_end = crm_ai.day_bounds(review.date, tz_of(data), end_hour_of(data))

    messages = (
        await db.scalars(
            select(CrmMessage)
            .where(CrmMessage.deal_id == review.deal_id, CrmMessage.at < day_end)
            .order_by(CrmMessage.at)
        )
    ).all()
    before = [m for m in messages if m.at < day_start][-crm_ai.CONTEXT_MESSAGES :]
    in_day = [m for m in messages if m.at >= day_start]
    events = (
        await db.scalars(
            select(CrmEvent)
            .where(CrmEvent.deal_id == review.deal_id, CrmEvent.at < day_end)
            .order_by(CrmEvent.at)
        )
    ).all()
    before_e = [e for e in events if e.at < day_start][-crm_ai.CONTEXT_EVENTS :]
    in_day_e = [e for e in events if e.at >= day_start]

    def msg(m: CrmMessage, inside: bool) -> CrmMessageOut:
        return CrmMessageOut(
            id=m.id, direction=m.direction, channel=m.channel, author_name=m.author_name,
            text=m.text, at=m.at, in_day=inside,
        )

    def ev(e: CrmEvent, inside: bool) -> CrmEventOut:
        return CrmEventOut(
            id=e.id, kind=e.kind, from_value=e.from_value, to_value=e.to_value, text=e.text,
            author_name=e.author_name, at=e.at, in_day=inside,
        )

    return CrmReviewDetailOut(
        **base.model_dump(),
        messages=[msg(m, False) for m in before] + [msg(m, True) for m in in_day],
        events=[ev(e, False) for e in before_e] + [ev(e, True) for e in in_day_e],
    )
