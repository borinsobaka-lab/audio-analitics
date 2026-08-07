"""Кто пришёл и что ему можно.

Три входа, и это не наследие, а три разных клиента:

1. Приложение на ресепшене — статический ключ устройства (X-Device-Key),
   привязанный к точке через DEVICE_API_KEYS.
2. Сотрудник в админке — логин и пароль, в обмен выдаётся сессионный токен
   (Authorization: Bearer). Область видимости берётся из его карточки.
3. Владелец — ADMIN_API_TOKEN. Оставлен намеренно: это ключ, которым в
   систему заходят до того, как в ней заведён хоть один пользователь, и
   которым в неё возвращаются, если пароль последнего администратора
   потерян. Он всегда видит всё.

Supabase JWT поддерживается как альтернатива владельческому токену для
совместимости с прежней настройкой.
"""
import uuid

import jwt
from fastapi import Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import get_settings
from .db import get_db
from .models import Employee
from .security import read_session

settings = get_settings()


class DeviceContext:
    def __init__(self, location_id: uuid.UUID):
        self.location_id = location_id


class UserContext:
    """Вошедший пользователь админки.

    scope: «all» — видит смены всех менеджеров и правит настройки;
           «own» — видит только свои смены и ничего не настраивает.
    """

    def __init__(
        self,
        user_id: str,
        email: str | None = None,
        employee_id: uuid.UUID | None = None,
        full_name: str = "",
        scope: str = "all",
        is_owner: bool = False,
    ):
        self.user_id = user_id
        self.email = email
        self.employee_id = employee_id
        self.full_name = full_name
        self.scope = scope
        self.is_owner = is_owner

    @property
    def can_view_all(self) -> bool:
        return self.scope == "all"

    @property
    def can_manage(self) -> bool:
        """Право на раздел сотрудников, метрики, промпты и удаление смен.

        Намеренно выведено из области видимости, а не заведено отдельным
        флажком: владелец ставит один переключатель «свои / все», и второго
        места, где доступ можно случайно разойтись с ожиданием, не возникает.
        """
        return self.scope == "all"

    @property
    def author_key(self) -> str:
        """Устойчивый ключ автора отзыва: у владельца сотрудника нет."""
        return f"emp:{self.employee_id}" if self.employee_id else "owner"

    def may_see_employee(self, employee_id: uuid.UUID | None) -> bool:
        if self.can_view_all:
            return True
        return employee_id is not None and employee_id == self.employee_id


async def require_device(x_device_key: str = Header(default="")) -> DeviceContext:
    key_map = settings.device_key_map()
    if not key_map:
        raise HTTPException(500, "DEVICE_API_KEYS is not configured")
    location_id = key_map.get(x_device_key)
    if not location_id:
        raise HTTPException(401, "Invalid device key")
    return DeviceContext(location_id=uuid.UUID(location_id))


def _owner_context() -> UserContext:
    return UserContext(user_id="owner", email="owner", scope="all", is_owner=True)


async def _employee_context(db: AsyncSession, token: str) -> UserContext | None:
    payload = read_session(token)
    if not payload:
        return None
    try:
        employee_id = uuid.UUID(payload.get("sub", ""))
    except ValueError:
        return None
    employee = await db.get(Employee, employee_id)
    if not employee or not employee.active or not employee.login:
        return None
    # Сессия привязана к моменту выдачи пароля: после сброса выданные раньше
    # токены перестают подходить, и «сбросить пароль» действительно выкидывает.
    issued_for = int(payload.get("pw") or 0)
    current = (
        int(employee.password_changed_at.timestamp())
        if employee.password_changed_at
        else 0
    )
    if issued_for != current:
        return None
    return UserContext(
        user_id=str(employee.id),
        email=employee.login,
        employee_id=employee.id,
        full_name=employee.full_name,
        scope=employee.access_scope or "own",
    )


async def require_user(
    authorization: str = Header(default=""),
    db: AsyncSession = Depends(get_db),
) -> UserContext:
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing bearer token")
    token = authorization.removeprefix("Bearer ").strip()

    if settings.admin_api_token and token == settings.admin_api_token:
        return _owner_context()

    context = await _employee_context(db, token)
    if context:
        return context

    if settings.supabase_jwt_secret:
        try:
            payload = jwt.decode(
                token,
                settings.supabase_jwt_secret,
                algorithms=["HS256"],
                audience="authenticated",
            )
        except jwt.PyJWTError:
            raise HTTPException(401, "Invalid access token") from None
        return UserContext(
            user_id=payload.get("sub", ""), email=payload.get("email"), scope="all"
        )

    if (
        not settings.admin_api_token
        and not settings.supabase_jwt_secret
        and settings.environment == "development"
    ):
        # Локальная разработка без настроенных секретов: сойдёт любой токен.
        return UserContext(user_id="dev", email="dev@local", scope="all")

    raise HTTPException(401, "Invalid access token")


async def require_manage(user: UserContext = Depends(require_user)) -> UserContext:
    """Только те, у кого доступ ко всем записям, меняют настройки системы."""
    if not user.can_manage:
        raise HTTPException(403, "Недостаточно прав: доступ только к своим сменам")
    return user


async def any_login_exists(db: AsyncSession) -> bool:
    """Заведён ли хоть один вход. Пока нет — админка подсказывает войти
    владельческим токеном, иначе форма логина выглядит тупиком."""
    return (
        await db.scalar(select(Employee.id).where(Employee.login.is_not(None)).limit(1))
    ) is not None


RequireDevice = Depends(require_device)
RequireUser = Depends(require_user)
RequireManage = Depends(require_manage)
