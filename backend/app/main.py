import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from . import crm_scheduler
from .config import get_settings
from .routers import (
    agreements,
    analytics,
    app_releases,
    audio,
    auth_router,
    crm,
    crm_ingest,
    crm_stats,
    employees,
    feedback,
    locations,
    metrics,
    playbook,
    playbook_calls,
    playbook_history,
    playbook_insights,
    playbook_settings,
    prompts,
    recordings,
    reports,
)

settings = get_settings()


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Разбор CRM за вчера запускается по расписанию из самого API: отдельный
    # процесс под расписание означал бы ещё одну строку в деплое.
    scheduler = asyncio.create_task(crm_scheduler.loop())
    try:
        yield
    finally:
        scheduler.cancel()


app = FastAPI(title=settings.app_name, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=(
        ["*"]
        if settings.environment == "development"
        else settings.cors_origin_list() or [settings.api_base_url]
    ),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # Админка на другом домене, и каждый запрос с токеном браузер сначала
    # «согласует» отдельным OPTIONS — лишний поход на сервер. Разрешение
    # кэшируется на сутки (Chrome держит до 2 часов): дальше без задержки.
    max_age=86400,
)

# Ответы сжимаются: дерево скриптов на трёх языках — ~110 КБ JSON, сжатое —
# ~28 КБ. На мобильном интернете это заметная часть времени открытия.
app.add_middleware(GZipMiddleware, minimum_size=1024)

app.include_router(auth_router.router)
app.include_router(app_releases.router)
app.include_router(recordings.router)
app.include_router(reports.router)
app.include_router(feedback.router)
app.include_router(agreements.router)
app.include_router(analytics.router)
app.include_router(employees.router)
app.include_router(locations.router)
app.include_router(metrics.router)
app.include_router(prompts.router)
app.include_router(prompts.script_router)
app.include_router(audio.router)
app.include_router(playbook.router)
app.include_router(playbook_insights.router)
app.include_router(playbook_calls.router)
app.include_router(playbook_history.router)
app.include_router(playbook_settings.router)
app.include_router(crm.router)
app.include_router(crm_stats.router)
app.include_router(crm_ingest.router)


@app.get("/health")
async def health():
    return {"status": "ok"}
