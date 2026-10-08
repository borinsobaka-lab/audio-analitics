"""Сводка разбора CRM в Telegram.

Разбор готов — владелец и старший администратор получают в общий чат
короткое сообщение: сколько сделок разобрано, сколько каких, насколько
стоит обратить внимание, главные ошибки и ссылка на страницу дня, где
сделки уже можно смотреть. Бот и чат — те же, что у других уведомлений:
токен и id чата в переменных окружения.

Текст собирается чистой функцией — её проверяет тест; отправка — одна
функция с httpx. Ошибка отправки никогда не роняет разбор: он ценнее
сообщения, и его всё равно видно в админке.
"""
from __future__ import annotations

import html
import logging
from datetime import date

import httpx

from .config import get_settings

log = logging.getLogger(__name__)

CATEGORY_RU = {
    "booking": "запись на пробное",
    "sale": "продажа абонемента",
    "objection": "возражение",
    "question": "вопрос клиента",
    "reschedule": "перенос или отмена",
    "service": "сервис",
    "no_reply": "клиент молчит",
    "lost": "отказ",
    "spam": "не клиент",
    "other": "другое",
}

MONTHS = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
]


class NotifyError(Exception):
    """Почему сообщение не ушло — словами для админки."""


def configured() -> bool:
    settings = get_settings()
    return bool(settings.telegram_bot_token.strip() and chat_ids())


def chat_ids() -> list[str]:
    return [c.strip() for c in get_settings().telegram_chat_id.split(",") if c.strip()]


def dashboard_base() -> str:
    settings = get_settings()
    base = settings.dashboard_url.strip() or next(iter(settings.cors_origin_list()), "")
    return base.rstrip("/")


def day_url(day: date) -> str:
    base = dashboard_base()
    return f"{base}/crm/days/{day.isoformat()}" if base else ""


def ru_date(day: date) -> str:
    return f"{day.day} {MONTHS[day.month - 1]}"


ATTENTION = {
    "none": "⚪️ Разбирать было нечего",
    "high": "🔴 Высокое — есть критичные ошибки или клиенты без ответа",
    "medium": "🟡 Среднее — есть что поправить, клиенты не потеряны",
    "low": "🟢 Всё в порядке",
}


def attention(stats: dict) -> tuple[str, str]:
    """Насколько стоит обратить внимание — по цифрам, не по настроению модели.
    Возвращает (уровень, подпись)."""
    deals = int(stats.get("deals") or 0)
    problems = int(stats.get("problems") or 0)
    critical = int(stats.get("critical") or 0)
    unanswered = int(stats.get("unanswered") or 0)
    if not deals:
        level = "none"
    elif critical or unanswered or problems / deals >= 0.5:
        level = "high"
    elif problems:
        level = "medium"
    else:
        level = "low"
    return level, ATTENTION[level]


def _plural(n: int, one: str, few: str, many: str) -> str:
    mod100 = n % 100
    if 11 <= mod100 <= 14:
        return many
    mod10 = n % 10
    if mod10 == 1:
        return one
    if 2 <= mod10 <= 4:
        return few
    return many


def build_message(
    *,
    day: date,
    stats: dict,
    summary: dict | None,
    url: str,
    window: str = "",
    error: str = "",
    tasks_created: int | None = None,
) -> str:
    """Текст сводки (HTML Telegram). Всё, что пришло от модели или из CRM,
    экранируется: имя администратора с «<» не должно ломать разметку."""
    title = f"<b>CRM — разбор за {ru_date(day)}</b>"
    if window:
        title += f"\n{html.escape(window)}"
    if error:
        lines = [
            f"⚠️ {title}",
            f"Разбор не удался: {html.escape(error[:300])}",
            "Запустите его заново в админке — «Разобрать день».",
        ]
        if url:
            lines.append(f'<a href="{html.escape(url, quote=True)}">Открыть CRM</a>')
        return "\n".join(lines)

    deals = int(stats.get("deals") or 0)
    problems = int(stats.get("problems") or 0)
    critical = int(stats.get("critical") or 0)
    unanswered = int(stats.get("unanswered") or 0)
    level, label = attention(stats)
    # Сделки, где клиент молчал: модели не отправлялись, проверены правилами.
    checks = (summary or {}).get("rule_checks") or {}
    quiet = int(checks.get("deals") or 0)
    quiet_line = (
        f"Без сообщений клиента, проверено правилами: {quiet} · "
        f"замечаний <b>{len(checks.get('items') or [])}</b>"
        if quiet
        else ""
    )
    lines = [title]
    if not deals:
        if quiet:
            # Клиенты не писали, но сделки двигали: уровень — по замечаниям правил.
            label = ATTENTION["medium" if checks.get("items") else "low"]
        lines.append(
            quiet_line or "За отчётный день в CRM не было ни переписки, ни движения сделок."
        )
        lines.append(f"<b>Внимание:</b> {label}")
        if url:
            lines.append(f'<a href="{html.escape(url, quote=True)}">Открыть CRM</a>')
        return "\n".join(lines)

    share = round(problems / deals * 100) if deals else 0
    lines.append(
        f"Разобрано {deals} {_plural(deals, 'сделка', 'сделки', 'сделок')} · "
        f"с замечаниями <b>{problems}</b> ({share}%) · критичных <b>{critical}</b> · "
        f"без ответа клиенту <b>{unanswered}</b>"
    )
    if quiet_line:
        lines.append(quiet_line)

    by_category = stats.get("by_category") or {}
    if by_category:
        parts = [
            f"{CATEGORY_RU.get(key, key)} — {count}"
            for key, count in sorted(by_category.items(), key=lambda kv: -int(kv[1] or 0))
        ]
        lines.append(f"<b>По типам:</b> {html.escape(', '.join(parts))}")

    by_manager = stats.get("by_manager") or {}
    if by_manager:
        parts = []
        for name, m in sorted(by_manager.items(), key=lambda kv: -int((kv[1] or {}).get("deals") or 0)):
            m = m or {}
            bit = f"{name} — {int(m.get('deals') or 0)}"
            extras = []
            if int(m.get("problems") or 0):
                extras.append(f"замечаний {int(m['problems'])}")
            if int(m.get("critical") or 0):
                extras.append(f"критичных {int(m['critical'])}")
            if int(m.get("unanswered") or 0):
                extras.append(f"без ответа {int(m['unanswered'])}")
            if extras:
                bit += f" ({', '.join(extras)})"
            parts.append(bit)
        lines.append(f"<b>По администраторам:</b> {html.escape('; '.join(parts))}")

    lines.append(f"<b>Внимание:</b> {label}")
    if tasks_created:
        lines.append(
            f"Поставлено задач менеджерам в amoCRM: <b>{tasks_created}</b>"
        )
    top = [t for t in ((summary or {}).get("top_problems") or []) if str(t).strip()][:4]
    if top and level != "low":
        lines.append("<b>Главное:</b>")
        lines.extend(f"• {html.escape(str(t).strip())}" for t in top)

    if url:
        lines.append(f'<a href="{html.escape(url, quote=True)}">Открыть разбор — сделки за день</a>')
    return "\n".join(lines)


def send(text: str) -> int:
    """Отправить во все чаты. Возвращает число доставленных; если бот или
    чат не настроены — NotifyError с подсказкой, что задать."""
    settings = get_settings()
    token = settings.telegram_bot_token.strip()
    ids = chat_ids()
    if not token or not ids:
        raise NotifyError(
            "Telegram не настроен: задайте TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в окружении бэкенда"
        )
    delivered = 0
    errors: list[str] = []
    with httpx.Client(timeout=20.0) as http:
        for chat_id in ids:
            try:
                resp = http.post(
                    f"https://api.telegram.org/bot{token}/sendMessage",
                    json={
                        "chat_id": chat_id,
                        "text": text,
                        "parse_mode": "HTML",
                        "disable_web_page_preview": True,
                    },
                )
            except httpx.HTTPError as exc:
                errors.append(f"{chat_id}: нет связи с Telegram ({exc})")
                continue
            if resp.status_code >= 400:
                detail = ""
                try:
                    detail = resp.json().get("description") or ""
                except ValueError:
                    pass
                errors.append(f"{chat_id}: Telegram ответил {resp.status_code} {detail}".strip())
                continue
            delivered += 1
    if errors:
        log.warning("telegram: %s", "; ".join(errors))
        if not delivered:
            raise NotifyError("; ".join(errors))
    return delivered


def notify_run(run, *, error: str = "", window: str = "", tasks_created: int | None = None) -> None:
    """Сводка по готовому (или упавшему) разбору — тихо: без исключений."""
    if not configured():
        return
    summary = dict(run.summary_json or {})
    stats = summary.pop("stats", None) or {}
    summary.pop("amo_tasks", None)
    summary.pop("amo_tasks_error", None)
    try:
        send(
            build_message(
                day=run.date,
                stats=stats,
                summary=summary,
                url=day_url(run.date),
                window=window,
                error=error,
                tasks_created=tasks_created,
            )
        )
    except NotifyError as exc:
        log.warning("telegram: сводка за %s не ушла: %s", run.date, exc)
    except Exception as exc:  # noqa: BLE001 — сообщение не ценнее разбора
        log.warning("telegram: %s", exc)
