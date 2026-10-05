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
    # Current models think before answering, and max_tokens caps thinking plus
    # the answer together — too low a limit returns an empty response.
    llm_max_tokens: int = 16000
    # Сегментация дня идёт блоками, а не одним запросом на всю смену: блок
    # режется только по паузам длиннее conversation_gap_s и не превышает этого
    # числа символов транскрипта. Кириллица и грузинский токенизируются дорого,
    # поэтому 40 000 символов — это порядка 15–25 тыс. токенов на вход.
    llm_stage1_block_chars: int = 40_000

    # --- Тарифы для подсчёта стоимости смены (USD) ---
    # Расход (минуты и токены) хранится отдельно от суммы, поэтому при смене
    # тарифов достаточно поправить эти значения — прошлые смены пересчитаются
    # кнопкой «Пересчитать», а новые сразу пойдут по новой цене.
    #
    # ASR: цена часа аудио у вашего провайдера. ВАЖНО — значение по умолчанию
    # ориентировочное, поставьте фактическое из своего тарифа ElevenLabs,
    # иначе стоимость в админке будет выглядеть достоверно и врать.
    price_asr_per_hour_usd: float = 0.40
    # LLM: цена за миллион токенов. По умолчанию — базовый прайс Sonnet 5.
    price_llm_input_per_mtok_usd: float = 3.00
    price_llm_output_per_mtok_usd: float = 15.00

    # --- Auth ---
    # Ключ приложения записи. Он один на всю сеть студий и вшивается в сборку
    # приложения: точку продажи сотрудник выбирает из списка, а не вводит ключ.
    # Прежняя схема (свой ключ на каждое устройство) продолжает работать.
    app_key: str = ""
    # Static API keys for desktop clients: "key1:location_id1,key2:location_id2"
    device_api_keys: str = ""
    # Static admin token for the dashboard: the owner's master key. Works even
    # before any employee login exists, and always sees everything.
    admin_api_token: str = ""
    # Ключ подписи сессий сотрудников. Если пуст, берётся ADMIN_API_TOKEN —
    # менять его значение означает разлогинить всех, это нормально.
    auth_secret: str = ""
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
    # Разбор, статус которого не двигался дольше этого (секунды), считается
    # зависшим: воркер убит, а смена так и осталась «в обработке». Пайплайн
    # обновляет статус по ходу дела, поэтому живой разбор сюда не попадает.
    stale_processing_s: int = 3 * 3600

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
