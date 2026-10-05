"""Вход в админку."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import UserContext, any_login_exists, require_user
from ..db import get_db
from ..models import Employee, utcnow
from ..schemas import LoginRequest, MeOut, SessionOut
from ..security import issue_session, login_guard, normalize_login, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.get("/state")
async def auth_state(db: AsyncSession = Depends(get_db)):
    """Что показывать на экране входа. Без авторизации намеренно: пока в
    системе нет ни одного логина, войти можно только владельческим токеном,
    и об этом надо сказать до входа, а не после."""
    return {"has_logins": await any_login_exists(db)}


@router.post("/login", response_model=SessionOut)
async def login(body: LoginRequest, db: AsyncSession = Depends(get_db)):
    login_value = normalize_login(body.login)
    locked = login_guard.seconds_locked(login_value)
    if locked:
        minutes = (locked + 59) // 60
        raise HTTPException(
            429,
            f"Слишком много неверных паролей подряд — вход закрыт ещё на {minutes} мин. "
            "Если пароль забыт, попросите администратора выдать новый.",
        )
    employee = await db.scalar(
        select(Employee).where(func.lower(Employee.login) == login_value)
    )
    # Один и тот же текст на «нет такого логина» и «неверный пароль»: разные
    # ответы позволяют перебором выяснить, кто в системе вообще заведён.
    invalid = HTTPException(401, "Неверный логин или пароль")
    # Неудачи считаются и по несуществующим логинам: иначе по тому, что
    # блокировка не наступает, видно, что такого логина нет.
    if not employee or not employee.active:
        login_guard.failed(login_value)
        raise invalid
    if not verify_password(body.password, employee.password_hash):
        login_guard.failed(login_value)
        raise invalid
    login_guard.reset(login_value)

    employee.last_login_at = utcnow()
    await db.commit()
    await db.refresh(employee)

    return SessionOut(
        token=issue_session(employee.id, employee.password_changed_at),
        user=MeOut(
            employee_id=employee.id,
            full_name=employee.full_name,
            login=employee.login,
            scope=employee.access_scope or "own",
            can_view_all=(employee.access_scope or "own") == "all",
            can_manage=(employee.access_scope or "own") == "all",
            can_edit_scripts=(employee.scripts_access or "read") == "edit",
            crm_scope=employee.crm_access or "own",
            can_view_all_crm=(employee.crm_access or "own") == "all",
            can_manage_crm=(employee.crm_access or "own") == "all",
            is_owner=False,
        ),
    )


@router.get("/me", response_model=MeOut)
async def me(user: UserContext = Depends(require_user)):
    return MeOut(
        employee_id=user.employee_id,
        full_name=user.full_name or ("Владелец" if user.is_owner else ""),
        login=user.email,
        scope=user.scope,
        can_view_all=user.can_view_all,
        can_manage=user.can_manage,
        can_edit_scripts=user.can_edit_scripts,
        crm_scope="all" if user.can_view_all_crm else "own",
        can_view_all_crm=user.can_view_all_crm,
        can_manage_crm=user.can_manage_crm,
        is_owner=user.is_owner,
    )
