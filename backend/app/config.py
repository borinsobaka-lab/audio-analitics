"""Application settings loaded from environment variables (.env)."""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # --- General ---
    app_name: str = "Audio Analytics"
    environment: str = "development"  # development | production
    api_base_url: str = "http://localhost:8000"

    # --- Database (Supabase Postgres or any PostgreSQL) ---
    # e.g. postgresql+asyncpg://postgres:pass@db.xxx.supabase.co:5432/postgres
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/audio_analytics"

    # --- Redis / Celery ---
    redis_url: str = "redis://localhost:6379/0"

    # --- Object storage (Cloudflare R2 / any S3-compatible) ---
    s3_endpoint_url: str = ""  # e.g. https://<account_id>.r2.cloudflarestorage.com
    s3_access_key_id: str = ""
    s3_secret_access_key: str = ""
    s3_bucket: str = "audio-analytics"
    s3_region: str = "auto"
    presigned_url_ttl_s: int = 3600

    # --- ASR: ElevenLabs Scribe ---
    elevenlabs_api_key: str = ""
    elevenlabs_model_id: str = "scribe_v2"

    # --- LLM: Anthropic Claude ---
    anthropic_api_key: str = ""
    llm_model_stage1: str = "claude-sonnet-5"
    llm_model_stage2: str = "claude-sonnet-5"
    llm_max_tokens: int = 8192

    # --- Auth ---
    # Static API keys for desktop clients: "key1:location_id1,key2:location_id2"
    device_api_keys: str = ""
    # Static admin token for the dashboard (simplest production auth).
    admin_api_token: str = ""
    # Supabase JWT secret for dashboard users (HS256), optional alternative.
    supabase_jwt_secret: str = ""
    # Comma-separated origins allowed for CORS (dashboard URLs).
    cors_origins: str = ""

    # --- Pipeline tuning ---
    vad_threshold: float = 0.5
    vad_min_speech_ms: int = 250
    vad_min_silence_ms: int = 500
    # A pause longer than this (seconds) splits speech into separate conversations.
    conversation_gap_s: float = 30.0
    # Audio retention in days (lifecycle policy should mirror this on the bucket).
    audio_retention_days: int = 60

    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    def device_key_map(self) -> dict[str, str]:
        """Parse device_api_keys into {api_key: location_id}."""
        result: dict[str, str] = {}
        for pair in self.device_api_keys.split(","):
            pair = pair.strip()
            if not pair:
                continue
            key, _, location_id = pair.partition(":")
            if key and location_id:
                result[key] = location_id
        return result


@lru_cache
def get_settings() -> Settings:
    return Settings()
