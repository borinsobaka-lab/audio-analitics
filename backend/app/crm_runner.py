"""Запуск разбора дня CRM — из самого API, в фоновом потоке.

Не через воркер Celery намеренно: воркер обрабатывает смены по одной, и
разбор CRM, поставленный в очередь в 20:00, ждал бы, пока закончится
распознавание двенадцатичасовой записи. Разбор CRM — это только запросы к
модели и база, без ffmpeg и аудио, поэтому ему хватает потока внутри API:
стартует ровно в назначенный час и ни от кого не зависит.
"""
import asyncio
import logging

log = logging.getLogger(__name__)

_running: set[asyncio.Task] = set()


def launch(run_id) -> None:
    """Запустить разбор в фоне. Ссылка на задачу хранится, пока она идёт,
    иначе сборщик мусора мог бы её прервать."""
    from .pipeline.crm_tasks import execute

    loop = asyncio.get_running_loop()
    task = loop.create_task(asyncio.to_thread(execute, str(run_id)))
    _running.add(task)
    task.add_done_callback(_running.discard)
    task.add_done_callback(_report)


def _report(task: asyncio.Task) -> None:
    if task.cancelled():
        return
    exc = task.exception()
    if exc:
        log.warning("crm run failed: %s", exc)
