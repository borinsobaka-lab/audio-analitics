"""Задачи менеджерам в amoCRM по итогам разбора CRM.

Разбор находит проблему в переписке — администратор узнаёт о ней не из
отчёта, который он не открывает, а задачей в своей amoCRM, на той самой
сделке: «ИИ-разбор за 06.10 — есть замечания. Что сделать: …» со сроком
через N рабочих часов. Ответственный — тот, кто вёл сделку в этот день.

Задачи ставит разбор по расписанию (если включено в настройках amoCRM) и
кнопка на странице дня. Какая сделка уже получила задачу по этому дню,
запоминается в разборе — повторный запуск дублей не ставит.

Отбор и текст — чистые функции (проверяются тестом), сеть — push().
"""
from __future__ import annotations

import asyncio
import logging
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

from . import amo, crm_ai, crm_notify

log = logging.getLogger(__name__)

SEVERITY_RANK = {"ok": 0, "warning": 1, "critical": 2}
SEVERITY_TEXT = {"warning": "есть замечания", "critical": "критично"}
# Тип задачи amoCRM «Связаться» — есть в любом аккаунте.
TASK_TYPE_CONTACT = 1
BATCH = 50
MAX_TEXT = 1500
DEFAULT_DUE_HOURS = 2
DEFAULT_TZ = "Asia/Tbilisi"


def config(amo_data: dict) -> dict:
    t = (amo_data or {}).get("tasks") or {}
    severity = t.get("min_severity") if t.get("min_severity") in ("warning", "critical") else "warning"
    try:
        due = max(1, min(72, int(t.get("due_hours") or DEFAULT_DUE_HOURS)))
    except (TypeError, ValueError):
        due = DEFAULT_DUE_HOURS
    return {"enabled": bool(t.get("enabled")), "min_severity": severity, "due_hours": due}


def row_of(review, deal) -> dict:
    """Разбор и сделка → плоский словарь для отбора (ORM не нужен)."""
    return {
        "deal": str(deal.external_id),
        "deal_title": deal.title or "",
        "deal_manager_key": str(deal.manager_key or ""),
        "manager_key": str(review.manager_key or ""),
        "severity": review.severity,
        "summary": review.summary or "",
        "recommendations": [str(x) for x in (review.recommendations_json or [])],
        "problems": [str(p.get("text") or "") for p in (review.problems_json or []) if isinstance(p, dict)],
    }


def task_text(day: date, row: dict, url: str) -> str:
    lines = [f"ИИ-разбор переписки за {day.strftime('%d.%m')} — {SEVERITY_TEXT.get(row['severity'], 'есть замечания')}."]
    if row["summary"]:
        lines.append(row["summary"])
    todo = [r for r in row["recommendations"] if r.strip()][:3] or [p for p in row["problems"] if p.strip()][:3]
    if todo:
        lines.append("Что сделать:")
        lines.extend(f"— {t.strip()}" for t in todo)
    if url:
        lines.append(f"Разбор: {url}")
    text = "\n".join(lines)
    return text if len(text) <= MAX_TEXT else text[: MAX_TEXT - 1] + "…"


def plan(rows: list[dict], users: dict, cfg: dict, done: dict, day: date, url: str) -> tuple[list[dict], dict]:
    """Какие задачи ставить. Возвращает (задачи, счётчики пропусков)."""
    threshold = SEVERITY_RANK[cfg["min_severity"]]
    counts = {"already": 0, "below": 0, "no_user": 0, "not_amo": 0}
    items: list[dict] = []
    for row in rows:
        if SEVERITY_RANK.get(row["severity"], 0) < max(1, threshold):
            counts["below"] += 1
            continue
        if row["deal"] in done:
            counts["already"] += 1
            continue
        if not row["deal"].isdigit():
            # Сделка пришла не из amoCRM — ставить задачу некуда.
            counts["not_amo"] += 1
            continue
        responsible = next(
            (
                key
                for key in (row["manager_key"], row["deal_manager_key"])
                if key.isdigit() and (not users or key in users)
            ),
            None,
        )
        if not responsible:
            counts["no_user"] += 1
            continue
        items.append(
            {
                "deal": row["deal"],
                "payload": {
                    "request_id": row["deal"],
                    "text": task_text(day, row, url),
                    "entity_id": int(row["deal"]),
                    "entity_type": "leads",
                    "responsible_user_id": int(responsible),
                    "task_type_id": TASK_TYPE_CONTACT,
                },
            }
        )
    return items, counts


async def push(base: str, token: str, items: list[dict], due: datetime) -> tuple[dict, list[str]]:
    """Поставить задачи пачками. Возвращает ({id сделки: id задачи}, ошибки)."""
    created: dict[str, str] = {}
    errors: list[str] = []
    if not items:
        return created, errors
    client = amo.AmoClient(base, token)
    try:
        for start in range(0, len(items), BATCH):
            chunk = items[start : start + BATCH]
            body = [{**i["payload"], "complete_till": int(due.timestamp())} for i in chunk]
            try:
                payload = await client.post("/api/v4/tasks", body)
            except amo.AmoError as exc:
                errors.append(str(exc))
                continue
            tasks = ((payload or {}).get("_embedded") or {}).get("tasks") or []
            for n, task in enumerate(tasks):
                deal = str(task.get("request_id") or (chunk[n]["deal"] if n < len(chunk) else ""))
                if deal and task.get("id") is not None:
                    created[deal] = str(task["id"])
            await asyncio.sleep(amo.REQUEST_PAUSE_S)
    finally:
        await client.close()
    return created, errors


def due_at(data: dict, cfg: dict, now: datetime | None = None) -> datetime:
    try:
        tz = ZoneInfo((data.get("timezone") or "").strip() or DEFAULT_TZ)
    except Exception:  # noqa: BLE001
        tz = ZoneInfo(DEFAULT_TZ)
    hours = crm_ai.work_hours_of(data, tz)
    return crm_ai.add_working_minutes(now or datetime.now(timezone.utc), cfg["due_hours"] * 60, hours)


def remember(run, created: dict, errors: list[str]) -> None:
    """Запомнить поставленные задачи в разборе — от дублей при повторе."""
    summary = dict(run.summary_json or {})
    summary["amo_tasks"] = {**(summary.get("amo_tasks") or {}), **created}
    if errors:
        summary["amo_tasks_error"] = "; ".join(errors)[:500]
    else:
        summary.pop("amo_tasks_error", None)
    run.summary_json = summary


def push_for_run_sync(db, run, data: dict) -> int | None:
    """После разбора по расписанию — из потока разбора. None — задачи
    выключены или amoCRM не подключена; ошибки не роняют разбор."""
    from sqlalchemy import select

    from .models import CrmDeal, CrmReview

    a = data.get("amo") or {}
    cfg = config(a)
    if not cfg["enabled"] or not a.get("access_token") or not a.get("subdomain"):
        return None
    reviews = list(db.scalars(select(CrmReview).where(CrmReview.run_id == run.id)))
    deals = {
        d.id: d for d in db.scalars(select(CrmDeal).where(CrmDeal.id.in_([r.deal_id for r in reviews])))
    } if reviews else {}
    rows = [row_of(r, deals[r.deal_id]) for r in reviews if r.deal_id in deals]
    done = (run.summary_json or {}).get("amo_tasks") or {}
    items, _ = plan(rows, (a.get("dicts") or {}).get("users") or {}, cfg, done, run.date, crm_notify.day_url(run.date))
    if not items:
        return 0
    base = amo.base_url(a["subdomain"], a.get("domain", ""))
    try:
        created, errors = asyncio.run(push(base, a["access_token"], items, due_at(data, cfg)))
    except Exception as exc:  # noqa: BLE001
        log.warning("amoCRM tasks for %s failed: %s", run.date, exc)
        created, errors = {}, [str(exc)]
    remember(run, created, errors)
    db.commit()
    if errors:
        log.warning("amoCRM tasks for %s: %s", run.date, "; ".join(errors))
    return len(created)
