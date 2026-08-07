from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .routers import (
    agreements,
    analytics,
    audio,
    auth_router,
    employees,
    feedback,
    metrics,
    prompts,
    recordings,
    reports,
)

settings = get_settings()

app = FastAPI(title=settings.app_name)

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
)

app.include_router(auth_router.router)
app.include_router(recordings.router)
app.include_router(reports.router)
app.include_router(feedback.router)
app.include_router(agreements.router)
app.include_router(analytics.router)
app.include_router(employees.router)
app.include_router(metrics.router)
app.include_router(prompts.router)
app.include_router(prompts.script_router)
app.include_router(audio.router)


@app.get("/health")
async def health():
    return {"status": "ok"}
