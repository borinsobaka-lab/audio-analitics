from celery import Celery

from .config import get_settings

settings = get_settings()

celery = Celery(
    "audio_analytics",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=["app.pipeline.tasks"],
)

celery.conf.update(
    task_acks_late=True,
    worker_prefetch_multiplier=1,  # long-running tasks: one at a time per worker
    task_time_limit=4 * 3600,
    task_soft_time_limit=4 * 3600 - 300,
    broker_connection_retry_on_startup=True,
)
