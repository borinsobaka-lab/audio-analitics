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



def generate_password() -> str:
    """Пароль из четырёх цифр — так решил владелец: его диктуют и набирают
    у стойки с телефона, длинный пароль там только мешал.

    Четыре цифры — всего 10 000 вариантов, поэтому перебор закрыт не длиной
    пароля, а блокировкой входа после нескольких неверных попыток подряд
    (LoginGuard ниже)."""
    return f"{secrets.randbelow(10_000):04d}"


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


class LoginGuard:
    """Блокировка входа по логину после нескольких неверных паролей подряд.

    Пароли короткие (четыре цифры), и без этой защиты их перебирают скриптом
    за минуты. После MAX_FAILURES неудач подряд логин закрыт на LOCK_SECONDS;
    верный пароль или выдача нового сбрасывают счётчик.

    Счётчики живут в памяти процесса: API работает одним процессом, а
    перезапуск, обнуляющий их, перебору не помогает — за время между
    деплоями попыток всё равно единицы.
    """

    MAX_FAILURES = 5
    LOCK_SECONDS = 15 * 60

    def __init__(self, clock=None):
        import time

        self._clock = clock or time.monotonic
        self._failures: dict[str, int] = {}
        self._locked_until: dict[str, float] = {}

    def seconds_locked(self, login: str) -> int:
        """Сколько секунд ещё закрыт вход; 0 — открыт."""
        until = self._locked_until.get(login)
        if until is None:
            return 0
        left = until - self._clock()
        if left <= 0:
            self._locked_until.pop(login, None)
            return 0
        return int(left) + 1

    def failed(self, login: str) -> None:
        count = self._failures.get(login, 0) + 1
        if count >= self.MAX_FAILURES:
            self._locked_until[login] = self._clock() + self.LOCK_SECONDS
            count = 0
        self._failures[login] = count

    def reset(self, login: str) -> None:
        self._failures.pop(login, None)
        self._locked_until.pop(login, None)


login_guard = LoginGuard()
