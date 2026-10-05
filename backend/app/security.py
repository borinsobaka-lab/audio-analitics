"""Пароли сотрудников и сессионные токены админки.

Пароль сотрудника нигде не хранится в открытом виде: он показывается один раз
в админке в момент создания или сброса, а в базу уходит только хеш. Поэтому
«забыл пароль» решается не восстановлением, а сбросом — владелец нажимает
«Сбросить», получает новый пароль и передаёт его сотруднику.

Хеш — PBKDF2-HMAC-SHA256 из стандартной библиотеки. Bcrypt/argon2 были бы
чуть лучше, но тянут бинарные зависимости в образ; при 600 000 итераций
перебор всё равно бессмысленен, а число итераций хранится внутри строки —
поднять его позже можно без миграции, старые хеши продолжат проверяться.
"""
import base64
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

import jwt

from .config import get_settings

PBKDF2_ITERATIONS = 600_000
SESSION_TTL_DAYS = 30

# Без похожих друг на друга символов: пароль диктуют голосом и переписывают
# от руки, а «l» против «1» и «O» против «0» — это звонок «не пускает».
_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"


def generate_password(groups: int = 4, size: int = 4) -> str:
    """Пароль вида «kira-4m7p-x2q9-vb38»: 80 бит, но читается вслух."""
    return "-".join(
        "".join(secrets.choice(_ALPHABET) for _ in range(size)) for _ in range(groups)
    )


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS)
    return "$".join(
        [
            "pbkdf2_sha256",
            str(PBKDF2_ITERATIONS),
            base64.b64encode(salt).decode(),
            base64.b64encode(digest).decode(),
        ]
    )


def verify_password(password: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        algorithm, iterations, salt_b64, digest_b64 = stored.split("$")
        if algorithm != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode(),
            base64.b64decode(salt_b64),
            int(iterations),
        )
    except (ValueError, TypeError):
        return False
    # Сравнение постоянного времени: обычное «==» выходит раньше на первом
    # несовпавшем байте и по времени ответа выдаёт, насколько угадали.
    return hmac.compare_digest(digest, base64.b64decode(digest_b64))


def normalize_login(login: str) -> str:
    """Логин нечувствителен к регистру и пробелам по краям: сотрудник вводит
    его вручную, и «Anna » не должно быть отдельным человеком."""
    return login.strip().lower()


def session_secret() -> bytes:
    """Ключ подписи сессий.

    Отдельная переменная, но с запасным вариантом: на уже поднятом сервере
    ADMIN_API_TOKEN задан, а AUTH_SECRET — нет, и без запасного варианта
    вход перестал бы работать сразу после обновления.

    Строка прогоняется через SHA-256: владелец мог задать короткий токен, а
    HMAC-SHA256 положено давать ключ не меньше 32 байт.
    """
    settings = get_settings()
    secret = (
        settings.auth_secret
        or settings.admin_api_token
        or settings.supabase_jwt_secret
    )
    if not secret and settings.environment == "development":
        secret = "dev-insecure-secret"
    return hashlib.sha256(secret.encode()).digest() if secret else b""


def issue_session(employee_id, password_changed_at: datetime | None) -> str:
    """Токен сессии. В нём лежит момент последней смены пароля: после сброса
    все выданные раньше токены перестают подходить сами собой."""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(employee_id),
        "pw": int(password_changed_at.timestamp()) if password_changed_at else 0,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(days=SESSION_TTL_DAYS)).timestamp()),
    }
    return jwt.encode(payload, session_secret(), algorithm="HS256")


def read_session(token: str) -> dict | None:
    secret = session_secret()
    if not secret:
        return None
    try:
        return jwt.decode(token, secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
