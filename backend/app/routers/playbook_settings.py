"""Настройки скриптов: имена студий и администраторов на трёх языках и
свои переменные — то, что подставляется в тексты само."""
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import UserContext, require_scripts_edit, require_user
from ..db import get_db
from ..models import Employee, Location, PlaybookSettings, utcnow
from ..schemas import AdminNamesOut, PlaybookSettingsIn, PlaybookSettingsOut, StudioNamesOut
from .playbook_common import author, current_org

router = APIRouter(prefix="/api/playbook", tags=["playbook"])


def first_name(full_name: str) -> str:
    """Имя по умолчанию — первое слово: в чате пишут «Меня зовут Анна», а не
    «Анна Гелашвили»."""
    parts = full_name.split()
    return parts[0] if parts else ""


@router.get("/settings", response_model=PlaybookSettingsOut)
async def get_settings(
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Читают все вошедшие: без настроек админка не подставит в скрипт ни
    имя администратора, ни студию, ни переменные."""
    org = await current_org(db)
    row = await db.get(PlaybookSettings, org.id)
    data = (row.data if row else None) or {}
    studios = data.get("studios", {})
    admins = data.get("admins", {})

    locations = (
        await db.scalars(select(Location).order_by(Location.active.desc(), Location.name))
    ).all()
    employees = (
        await db.scalars(
            select(Employee)
            .where(Employee.active.is_(True))
            .order_by(Employee.login.is_(None), Employee.full_name)
        )
    ).all()

    def names(saved: dict | None, default_ru: str) -> dict:
        saved = saved or {}
        return {
            "ru": saved.get("ru") or default_ru,
            "en": saved.get("en", ""),
            "ka": saved.get("ka", ""),
        }

    return PlaybookSettingsOut(
        studios=[
            StudioNamesOut(
                location_id=loc.id,
                location_name=loc.name,
                active=loc.active,
                **names(studios.get(str(loc.id)), loc.name),
            )
            for loc in locations
        ],
        admins=[
            AdminNamesOut(
                employee_id=emp.id,
                full_name=emp.full_name,
                has_login=bool(emp.login),
                **names(admins.get(str(emp.id)), first_name(emp.full_name)),
            )
            for emp in employees
        ],
        variables=data.get("variables", []),
        updated_at=row.updated_at if row else None,
        updated_by=row.updated_by if row else "",
    )


@router.put("/settings", response_model=PlaybookSettingsOut)
async def save_settings(
    body: PlaybookSettingsIn,
    user: UserContext = Depends(require_scripts_edit),
    db: AsyncSession = Depends(get_db),
):
    org = await current_org(db)

    def clean(texts) -> dict:
        return {lang: getattr(texts, lang).strip() for lang in ("ru", "en", "ka")}

    row = await db.get(PlaybookSettings, org.id)
    # Остальное в настройках (промпт ИИ-помощника) правится на своей вкладке
    # и здесь не теряется.
    data = {
        **dict((row.data if row else None) or {}),
        "studios": {str(k): clean(v) for k, v in body.studios.items()},
        "admins": {str(k): clean(v) for k, v in body.admins.items()},
        "variables": [
            {
                "key": v.key.strip(),
                "type": v.type,
                "description": v.description.strip(),
                # У даты текстов нет — значение считается от сегодняшнего дня.
                "ru": v.ru.strip() if v.type == "text" else "",
                "en": v.en.strip() if v.type == "text" else "",
                "ka": v.ka.strip() if v.type == "text" else "",
                "offset_days": v.offset_days if v.type == "date" else 0,
            }
            for v in body.variables
        ],
    }
    if row:
        row.data = data
        row.updated_at = utcnow()
        row.updated_by = author(user)
    else:
        db.add(PlaybookSettings(org_id=org.id, data=data, updated_by=author(user)))
    await db.commit()
    return await get_settings(user, db)
