"""Разбор одного дня CRM.

Все сделки, по которым за отчётный день была переписка или движение, по
одной уходят в модель вместе с базой знаний студии. База — один и тот же
системный блок на весь день с кэшированием у провайдера: сделок за день
десятки, а база — десять тысяч токенов, платить за неё каждый раз незачем.

Выполняется в потоке внутри API (crm_runner.py), а не в воркере Celery:
старт ровно в назначенный час не должен ждать обработку аудио смены.
"""
import logging
import traceback
import uuid
from zoneinfo import ZoneInfo

from sqlalchemy import select

from .. import amo_tasks, crm_ai, crm_notify, playbook_ai
from ..config import get_settings
from ..db import get_sync_db
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
    PlaybookItem,
    PlaybookSection,
    PlaybookSettings,
    ScriptTemplate,
    utcnow,
)
from ..routers.playbook_insights import variables_hint
from .cost import compute_cost
from .llm import LlmClient

logger = logging.getLogger(__name__)

DEFAULT_TZ = "Asia/Tbilisi"
# Предохранитель от счёта: день с сотнями сделок разбирается не целиком.
DEFAULT_MAX_DEALS = 400


def end_hour_of(data: dict) -> int:
    try:
        return max(0, min(23, int(data.get("run_hour", 20))))
    except (TypeError, ValueError):
        return 20


def execute(run_id: str) -> str:
    """Разобрать день: статусы, ошибки и сводка в Telegram — здесь."""
    db = get_sync_db()
    window = ""
    try:
        run = db.get(CrmRun, uuid.UUID(run_id))
        if not run:
            return f"crm run {run_id} not found"
        row = db.get(CrmSettings, run.org_id)
        data = dict((row.data if row else None) or {})
        hour = end_hour_of(data)
        window = crm_ai.day_label(run.date, hour) if hour else ""
        run.set_status("processing", "подготовка данных")
        db.commit()
        result = _run(db, run, data)
        run.set_status("done")
        run.finished_at = utcnow()
        db.commit()
        # Задачи в amoCRM и сводка в чат — только у разбора по расписанию:
        # повторный запуск руками не должен слать их заново.
        if run.trigger == "schedule":
            try:
                tasks = amo_tasks.push_for_run_sync(db, run, data)
            except Exception as exc:  # noqa: BLE001 — задачи не ценнее разбора
                logger.warning("amoCRM tasks: %s", exc)
                db.rollback()
                tasks = None
            crm_notify.notify_run(run, window=window, tasks_created=tasks)
        return result
    except Exception as e:  # noqa: BLE001 — ошибка уходит в статус разбора
        db.rollback()
        run = db.get(CrmRun, uuid.UUID(run_id))
        if run:
            run.set_status("error", f"{e}\n{traceback.format_exc()[-1500:]}")
            run.finished_at = utcnow()
            db.commit()
            if run.trigger == "schedule":
                crm_notify.notify_run(run, error=str(e), window=window)
        raise
    finally:
        db.close()


def _progress(db, run: CrmRun, detail: str) -> None:
    """Пояснение видно в админке и заодно подтверждает, что разбор жив."""
    run.set_status(detail=detail)
    db.commit()


def load_knowledge(db, org_id, data: dict) -> str:
    """База знаний для модели: каталог скриптов (тот же, что у ИИ-помощника),
    правила продаж из «Аналитики», правила воронки из настроек CRM и
    переменные с их значениями."""
    sections = list(
        db.scalars(
            select(PlaybookSection)
            .where(PlaybookSection.org_id == org_id)
            .order_by(PlaybookSection.position, PlaybookSection.created_at)
        )
    )
    items = list(
        db.scalars(
            select(PlaybookItem)
            .where(PlaybookItem.org_id == org_id)
            .order_by(PlaybookItem.position, PlaybookItem.title)
        )
    )
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
    script = db.scalar(
        select(ScriptTemplate)
        .where(ScriptTemplate.org_id == org_id, ScriptTemplate.active.is_(True))
        .order_by(ScriptTemplate.version.desc())
    )
    pb = db.get(PlaybookSettings, org_id)
    pb_data = dict((pb.data if pb else None) or {})
    return crm_ai.build_knowledge(
        catalog=playbook_ai.build_catalog(tree),
        sales_rules=playbook_ai.build_sales_rules(
            {"stages": script.stages_json, "body": script.body} if script else None
        ),
        pipeline_rules=(data.get("pipeline_rules") or "").strip() or crm_ai.DEFAULT_PIPELINE_RULES,
        variables=variables_hint(pb_data),
    )


def _message_dict(m: CrmMessage) -> dict:
    return {
        "direction": m.direction,
        "channel": m.channel,
        "author_key": m.author_key,
        "author_name": m.author_name,
        "text": m.text,
        "at": m.at,
    }


def _event_dict(e: CrmEvent) -> dict:
    return {
        "kind": e.kind,
        "from_value": e.from_value,
        "to_value": e.to_value,
        "text": e.text,
        "author_key": e.author_key,
        "author_name": e.author_name,
        "at": e.at,
    }


def _deal_dict(d: CrmDeal) -> dict:
    return {
        "external_id": d.external_id,
        "title": d.title,
        "contact_name": d.contact_name,
        "contact_phone": d.contact_phone,
        "pipeline": d.pipeline,
        "stage": d.stage,
        "status": d.status,
        "source": d.source,
        "manager_key": d.manager_key,
        "manager_name": d.manager_name,
        "budget": d.budget,
        "created_at_crm": d.created_at_crm,
    }


def _finish_cost(db, run: CrmRun, llm: LlmClient | None) -> float:
    settings = get_settings()
    usage = llm.usage if llm else None
    run.llm_input_tokens = usage.input_tokens if usage else 0
    run.llm_output_tokens = usage.output_tokens if usage else 0
    run.llm_calls = usage.calls if usage else 0
    cost = compute_cost(
        0.0,
        run.llm_input_tokens,
        run.llm_output_tokens,
        settings.price_asr_per_hour_usd,
        settings.price_llm_input_per_mtok_usd,
        settings.price_llm_output_per_mtok_usd,
    )
    run.cost_usd = cost.total_usd
    db.commit()
    return cost.total_usd


def _run(db, run: CrmRun, data: dict) -> str:
    settings = get_settings()
    tz = ZoneInfo(data.get("timezone") or DEFAULT_TZ)
    hour = end_hour_of(data)
    day_start, day_end = crm_ai.day_bounds(run.date, tz, hour)
    date_label = crm_ai.day_label(run.date, hour)

    hours = crm_ai.work_hours_of(data, tz)
    slow = int(data.get("slow_reply_minutes") or crm_ai.DEFAULT_SLOW_REPLY_MINUTES)
    hours_label = crm_ai.describe_hours(hours)

    # Повторный запуск заменяет прошлый разбор целиком — кроме списка
    # поставленных задач в amoCRM: он защищает от дублей.
    amo_tasks_done = (run.summary_json or {}).get("amo_tasks") or {}
    for old in db.scalars(select(CrmReview).where(CrmReview.run_id == run.id)):
        db.delete(old)
    run.summary_json = {"amo_tasks": amo_tasks_done} if amo_tasks_done else None
    run.reviews_done = 0
    run.problems_count = 0
    db.commit()

    touched = set(
        db.scalars(
            select(CrmMessage.deal_id)
            .where(
                CrmMessage.org_id == run.org_id,
                CrmMessage.at >= day_start,
                CrmMessage.at < day_end,
            )
            .distinct()
        )
    ) | set(
        db.scalars(
            select(CrmEvent.deal_id)
            .where(
                CrmEvent.org_id == run.org_id,
                CrmEvent.at >= day_start,
                CrmEvent.at < day_end,
            )
            .distinct()
        )
    )
    deals = (
        list(
            db.scalars(
                select(CrmDeal)
                .where(CrmDeal.id.in_(touched))
                .order_by(CrmDeal.last_activity_at.desc().nulls_last(), CrmDeal.title)
            )
        )
        if touched
        else []
    )
    # Лимит считается по разобранным сделкам: исключённые настройками
    # «Что разбирать» его не съедают.
    max_deals = max(1, int(data.get("max_deals") or DEFAULT_MAX_DEALS))
    skipped = 0
    excluded: dict[str, int] = {}
    run.deals_total = len(deals)
    db.commit()

    if not deals:
        _finish_cost(db, run, None)
        line = "за этот день в CRM не было ни переписки, ни движения сделок"
        run.set_status(detail=line)
        db.commit()
        return line

    criteria = [
        {"id": str(c.id), "name": c.name, "prompt": c.prompt, "scale_max": c.scale_max}
        for c in db.scalars(
            select(CrmCriterion)
            .where(CrmCriterion.org_id == run.org_id, CrmCriterion.active.is_(True))
            .order_by(CrmCriterion.position, CrmCriterion.created_at)
        )
    ]
    employees = [
        {"id": e.id, "full_name": e.full_name}
        for e in db.scalars(select(Employee).where(Employee.org_id == run.org_id))
    ]
    manager_map = data.get("manager_map") or {}

    _progress(db, run, "сборка базы знаний")
    knowledge = load_knowledge(db, run.org_id, data)
    # Один блок на весь день — кэшируется у провайдера.
    system = [{"type": "text", "text": knowledge, "cache_control": {"type": "ephemeral"}}]
    model = (data.get("model") or "").strip() or settings.llm_model_stage2
    instructions = (data.get("prompt") or "").strip() or crm_ai.DEFAULT_PROMPT
    llm = LlmClient()

    normalized: list[dict] = []
    for_summary: list[dict] = []
    failed = 0
    for i, deal in enumerate(deals, start=1):
        _progress(db, run, f"разбор сделок: {i} из {len(deals)}")
        messages = [
            _message_dict(m)
            for m in db.scalars(
                select(CrmMessage)
                .where(CrmMessage.deal_id == deal.id, CrmMessage.at < day_end)
                .order_by(CrmMessage.at)
            )
        ]
        events = [
            _event_dict(e)
            for e in db.scalars(
                select(CrmEvent)
                .where(CrmEvent.deal_id == deal.id, CrmEvent.at < day_end)
                .order_by(CrmEvent.at)
            )
        ]
        day_m = [m for m in messages if m["at"] >= day_start]
        day_e = [e for e in events if e["at"] >= day_start]
        deal_dict = _deal_dict(deal)
        manager_key, manager_name = crm_ai.day_manager(deal_dict, day_m, day_e)
        reason = crm_ai.exclusion_reason(
            pipeline=deal.pipeline,
            stage=crm_ai.stage_at(deal.stage, events, day_end),
            manager_key=manager_key,
            data=data,
        )
        if reason:
            excluded[reason] = excluded.get(reason, 0) + 1
            continue
        if run.reviews_done + failed >= max_deals:
            skipped += 1
            continue
        speed = crm_ai.reply_stats(messages, day_start, day_end, hours, slow)
        employee_id = crm_ai.resolve_employee(manager_key, manager_name, manager_map, employees)

        prompt = crm_ai.review_prompt(
            date_label=date_label,
            instructions=instructions,
            criteria=criteria,
            deal_text=crm_ai.render_deal(deal_dict, messages, events, day_start, day_end, tz, date_label),
            work_hours=hours_label,
            speed=crm_ai.speed_text(speed, slow),
        )
        # Одна упавшая сделка не должна стоить всего дня.
        try:
            raw = llm.complete_json(prompt, model, system=system)
        except Exception as e:  # noqa: BLE001
            failed += 1
            logger.warning("crm review of deal %s failed: %s", deal.external_id, e)
            continue
        result = crm_ai.normalize_review(raw, criteria)

        review = CrmReview(
            org_id=run.org_id,
            run_id=run.id,
            deal_id=deal.id,
            date=run.date,
            employee_id=employee_id,
            manager_key=manager_key,
            manager_name=manager_name,
            category=result["category"],
            severity=result["severity"],
            problem=result["problem"],
            summary=result["summary"],
            problems_json=result["problems"],
            good_json=result["good"],
            recommendations_json=result["recommendations"],
            scripts_json=result["scripts"],
            pipeline_json=result["pipeline"],
            messages_in=speed["messages_in"],
            messages_out=speed["messages_out"],
            events_count=len(day_e),
            first_reply_minutes=speed["first_reply_minutes"],
            max_reply_minutes=speed["max_reply_minutes"],
            unanswered=speed["unanswered"],
        )
        db.add(review)
        db.flush()
        for s in result["scores"]:
            db.add(
                CrmReviewScore(
                    review_id=review.id,
                    criterion_id=uuid.UUID(s["criterion_id"]),
                    applicable=s["applicable"],
                    score=s["score"],
                    comment=s["comment"],
                )
            )
        run.reviews_done += 1
        run.problems_count += 1 if result["problem"] else 0
        db.commit()

        normalized.append(
            {
                **result,
                "manager_name": manager_name,
                "unanswered": speed["unanswered"],
                "first_reply_minutes": speed["first_reply_minutes"],
            }
        )
        names = {c["id"]: c["name"] for c in criteria}
        for_summary.append(
            {
                "deal": deal.title or f"#{deal.external_id}",
                "manager": manager_name or "не указан",
                "category": result["category"],
                "severity": result["severity"],
                "summary": result["summary"],
                "problems": [p["text"] for p in result["problems"]],
                "unanswered": speed["unanswered"],
                "first_reply_minutes": speed["first_reply_minutes"],
                "scores": {
                    names.get(s["criterion_id"], s["criterion_id"]): s["score"]
                    for s in result["scores"]
                    if s["applicable"]
                },
            }
        )

    stats = crm_ai.day_stats(normalized, criteria)
    summary: dict = {}
    if normalized:
        _progress(db, run, "итог дня")
        try:
            summary = crm_ai.normalize_summary(
                llm.complete_json(
                    crm_ai.summary_prompt(
                        date_label=date_label,
                        instructions=(data.get("summary_prompt") or "").strip()
                        or crm_ai.DEFAULT_SUMMARY_PROMPT,
                        stats=stats,
                        reviews=for_summary,
                    ),
                    model,
                )
            )
        except Exception as e:  # noqa: BLE001 — разборы ценнее итога
            logger.warning("crm daily summary failed: %s", e)
            summary = {"error": str(e)[:500]}
    run.summary_json = {
        **summary,
        "stats": stats,
        **({"amo_tasks": amo_tasks_done} if amo_tasks_done else {}),
    }
    db.commit()

    cost = _finish_cost(db, run, llm)
    parts = [f"сделок: {run.reviews_done}"]
    parts.append(f"проблемных: {run.problems_count}")
    if stats.get("critical"):
        parts.append(f"критичных: {stats['critical']}")
    parts.append(
        f"критериев: {len(criteria)}" if criteria else "критериев не было — добавьте их в настройках"
    )
    if failed:
        parts.append(f"ошибок разбора: {failed}")
    if excluded:
        names = {"воронка": "воронки", "этап": "этапы", "менеджер": "менеджеры"}
        parts.append(
            "исключено настройками: "
            + ", ".join(f"{names.get(k, k)} {v}" for k, v in excluded.items())
        )
    if skipped:
        parts.append(f"пропущено сделок сверх лимита {max_deals}: {skipped}")
    parts.append(f"стоимость: ${cost:.3f}")
    line = ", ".join(parts)
    run.set_status(detail=line)
    db.commit()
    return line
