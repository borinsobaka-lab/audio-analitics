"""Async SQLAlchemy engine/session + sync engine for Celery workers."""
from collections.abc import AsyncGenerator

from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import Session, sessionmaker

from .config import get_settings

settings = get_settings()

async_engine = create_async_engine(settings.database_url, pool_pre_ping=True)
async_session_factory = async_sessionmaker(async_engine, expire_on_commit=False)

# Celery workers are synchronous: reuse the same URL with a sync driver.
_sync_url = settings.database_url.replace("+asyncpg", "+psycopg2")
sync_engine = create_engine(_sync_url, pool_pre_ping=True)
sync_session_factory = sessionmaker(sync_engine, expire_on_commit=False)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_factory() as session:
        yield session


def get_sync_db() -> Session:
    return sync_session_factory()
