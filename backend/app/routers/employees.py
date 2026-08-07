"""Сотрудники: и список для приложения, и пользователи админки.

Раздел целиком закрыт правом «видит все записи»: сотрудник, которому открыты
только свои смены, не может ни завести пользователя, ни расширить себе доступ.
Единственное исключение — чтение списка: имена нужны и в отчётах.

Деактивация никогда не удаляет: прошлые разборы должны остаться подписаны тем,
кто их наработал, поэтому отключённый менеджер лишь исчезает из выбора в
приложении и теряет вход.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import UserContext, require_manage, require_user
from ..db import get_db
from ..models import (
    Agreement,
    DayRecording,
    DialogFeedback,
    Employee,
    Location,
    utcnow,
)
from ..schemas import (
    EmployeeCreate,
    EmployeeCredentialsOut,
    EmployeeOut,
    EmployeeUpdate,
)
from ..security import generate_password, hash_password, normalize_login

router = APIRouter(prefix="/api/employees", tags=["employees"])

MIN_LOGIN_LEN = 3


def to_out(employee: Employee) -> EmployeeOut:
    out = EmployeeOut.model_validate(employee)
    out.has_password = bool(employee.password_hash)
    return out


async def default_location(db: AsyncSession) -> Location:
    location = await db.scalar(select(Location).order_by(Location.name).limit(1))
    if not location:
        raise HTTPException(400, "Не создано ни одной точки — выполните seed")
    return location


async def check_login_free(
    db: AsyncSession, login: str, exclude_id: uuid.UUID | None = None
) -> str:
    value = normalize_login(login)
    if len(value) < MIN_LOGIN_LEN:
        raise HTTPException(400, f"Логин короче {MIN_LOGIN_LEN} символов")
    if any(ch.isspace() for ch in value):
        raise HTTPException(400, "В логине не должно быть пробелов")
    q = select(Employee).where(func.lower(Employee.login) == value)
    if exclude_id:
        q = q.where(Employee.id != exclude_id)
    if await db.scalar(q):
        raise HTTPException(409, f"Логин «{value}» уже занят")
    return value


async def issue_password(db: AsyncSession, employee: Employee) -> str:
    """Выдать новый пароль. Возвращается открытым один раз — дальше только хеш."""
    password = generate_password()
    employee.password_hash = hash_password(password)
    employee.password_changed_at = utcnow()
    await db.commit()
    await db.refresh(employee)
    return password


@router.get("", response_model=list[EmployeeOut])
async def list_employees(
    include_inactive: bool = True,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    q = select(Employee).order_by(Employee.active.desc(), Employee.full_name)
    if not include_inactive:
        q = q.where(Employee.active.is_(True))
    return [to_out(e) for e in (await db.scalars(q)).all()]


@router.post("", response_model=EmployeeCredentialsOut, status_code=201)
async def create_employee(
    body: EmployeeCreate,
    user: UserContext = Depends(require_manage),
    db: AsyncSession = Depends(get_db),
):
    if body.location_id:
        location = await db.get(Location, body.location_id)
        if not location:
            raise HTTPException(404, "Точка не найдена")
    else:
        location = await default_location(db)

    name = body.full_name.strip()
    duplicate = await db.scalar(
        select(Employee).where(
            Employee.location_id == location.id, Employee.full_name == name
        )
    )
    if duplicate:
        raise HTTPException(409, f"Менеджер «{name}» уже заведён на этой точке")

    login = await check_login_free(db, body.login) if body.login else None

    employee = Employee(
        org_id=location.org_id,
        location_id=location.id,
        full_name=name,
        role=body.role or "manager",
        active=True,
        login=login,
        access_scope=body.access_scope,
    )
    db.add(employee)
    await db.commit()
    await db.refresh(employee)

    # Пароль создаётся вместе с логином и показывается один раз: владелец
    # копирует его и передаёт сотруднику, повторно посмотреть нельзя.
    password = await issue_password(db, employee) if login else ""
    return EmployeeCredentialsOut(
        employee=to_out(employee), login=login or "", password=password
    )


@router.patch("/{employee_id}", response_model=EmployeeCredentialsOut)
async def update_employee(
    employee_id: uuid.UUID,
    body: EmployeeUpdate,
    user: UserContext = Depends(require_manage),
    db: AsyncSession = Depends(get_db),
):
    employee = await db.get(Employee, employee_id)
    if not employee:
        raise HTTPException(404, "Менеджер не найден")

    if body.full_name is not None:
        employee.full_name = body.full_name.strip()
    if body.active is not None:
        if not body.active and employee.id == user.employee_id:
            raise HTTPException(400, "Нельзя отключить собственную учётную запись")
        employee.active = body.active
    if body.access_scope is not None:
        if employee.id == user.employee_id and body.access_scope != "all":
            # Иначе администратор одним нажатием запирает сам себя, и вернуть
            # доступ можно только владельческим токеном.
            raise HTTPException(400, "Нельзя снять с себя доступ ко всем записям")
        employee.access_scope = body.access_scope

    password = ""
    if body.login is not None:
        new_login = normalize_login(body.login)
        if not new_login:
            # Снятие логина: сотрудник остаётся в списке приложения, но входа
            # больше нет, а старая сессия перестаёт работать.
            employee.login = None
            employee.password_hash = None
            employee.password_changed_at = None
        elif new_login != (employee.login or ""):
            employee.login = await check_login_free(db, new_login, employee.id)

    await db.commit()
    await db.refresh(employee)

    if employee.login and not employee.password_hash:
        password = await issue_password(db, employee)

    return EmployeeCredentialsOut(
        employee=to_out(employee), login=employee.login or "", password=password
    )


@router.post("/{employee_id}/reset-password", response_model=EmployeeCredentialsOut)
async def reset_password(
    employee_id: uuid.UUID,
    user: UserContext = Depends(require_manage),
    db: AsyncSession = Depends(get_db),
):
    """Выдать новый пароль взамен забытого. Все прежние сессии сотрудника
    после этого недействительны."""
    employee = await db.get(Employee, employee_id)
    if not employee:
        raise HTTPException(404, "Менеджер не найден")
    if not employee.login:
        raise HTTPException(400, "У сотрудника нет логина — сначала выдайте доступ")
    password = await issue_password(db, employee)
    return EmployeeCredentialsOut(
        employee=to_out(employee), login=employee.login, password=password
    )


@router.delete("/{employee_id}", status_code=204)
async def delete_employee(
    employee_id: uuid.UUID,
    user: UserContext = Depends(require_manage),
    db: AsyncSession = Depends(get_db),
):
    """Удалить сотрудника целиком — только пока за ним нет ни одной смены.

    Если смены есть, удаление сделало бы прошлые отчёты безымянными, поэтому
    вместо него предлагается отключение: имя остаётся, вход пропадает.
    """
    employee = await db.get(Employee, employee_id)
    if not employee:
        raise HTTPException(404, "Менеджер не найден")
    if employee.id == user.employee_id:
        raise HTTPException(400, "Нельзя удалить собственную учётную запись")
    recorded = await db.scalar(
        select(DayRecording.id).where(DayRecording.employee_id == employee_id).limit(1)
    )
    if recorded:
        raise HTTPException(
            409,
            "За сотрудником есть смены — его можно только отключить, "
            "иначе прошлые разборы останутся без имени",
        )
    # Отзывы и договорённости, написанные этим человеком, остаются: имя автора
    # хранится в них строкой, поэтому сама запись читается и без ссылки. Иначе
    # удаление сотрудника унесло бы чужие разборы вместе с ним.
    await db.execute(
        update(DialogFeedback)
        .where(DialogFeedback.author_employee_id == employee_id)
        .values(author_employee_id=None)
    )
    await db.execute(
        update(Agreement)
        .where(Agreement.created_by_employee_id == employee_id)
        .values(created_by_employee_id=None)
    )
    await db.delete(employee)
    await db.commit()
    return None
