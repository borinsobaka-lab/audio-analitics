"""Точки продажи — студии сети.

Одна точка = одна студия = один ресепшен, на котором стоит компьютер с
приложением записи. Всё остальное к точке привязано: сотрудники, смены,
отчёты.

Смысл раздела в том, чтобы у сотрудника на ресепшене не осталось ни одной
настройки, в которой можно ошибиться. Раньше он вводил адрес сервера и ключ
устройства — две строки, набранные с чужих слов, и любая опечатка выглядела
как «сервер недоступен». Теперь точки заводит владелец здесь, а приложение
показывает их списком: выбрал свою студию — и больше не возвращается.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import UserContext, require_manage, require_user
from ..db import get_db
from ..models import DayRecording, Employee, Location, Organization
from ..schemas import LocationCreate, LocationOut, LocationUpdate

router = APIRouter(prefix="/api/locations", tags=["locations"])


async def to_out(db: AsyncSession, location: Location) -> LocationOut:
    out = LocationOut.model_validate(location)
    out.employees_count = (
        await db.scalar(
            select(func.count())
            .select_from(Employee)
            .where(Employee.location_id == location.id, Employee.active.is_(True))
        )
    ) or 0
    out.shifts_count = (
        await db.scalar(
            select(func.count())
            .select_from(DayRecording)
            .where(DayRecording.location_id == location.id)
        )
    ) or 0
    return out


@router.get("", response_model=list[LocationOut])
async def list_locations(
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Читают все вошедшие: переключатель студии есть и у менеджера, а имя
    точки подписывает смену в отчётах."""
    rows = await db.scalars(
        select(Location).order_by(Location.active.desc(), Location.name)
    )
    return [await to_out(db, row) for row in rows]


@router.post("", response_model=LocationOut, status_code=201)
async def create_location(
    body: LocationCreate,
    user: UserContext = Depends(require_manage),
    db: AsyncSession = Depends(get_db),
):
    org = await db.scalar(select(Organization).limit(1))
    if not org:
        raise HTTPException(400, "Организация не создана — выполните seed")

    name = body.name.strip()
    duplicate = await db.scalar(
        select(Location).where(func.lower(Location.name) == name.lower())
    )
    if duplicate:
        raise HTTPException(409, f"Точка «{name}» уже заведена")

    location = Location(
        org_id=org.id,
        name=name,
        address=body.address.strip(),
        timezone=body.timezone or "Asia/Tbilisi",
        active=True,
    )
    db.add(location)
    await db.commit()
    await db.refresh(location)
    return await to_out(db, location)


@router.patch("/{location_id}", response_model=LocationOut)
async def update_location(
    location_id: uuid.UUID,
    body: LocationUpdate,
    user: UserContext = Depends(require_manage),
    db: AsyncSession = Depends(get_db),
):
    location = await db.get(Location, location_id)
    if not location:
        raise HTTPException(404, "Точка не найдена")
    if body.name is not None:
        location.name = body.name.strip()
    if body.address is not None:
        location.address = body.address.strip()
    if body.timezone is not None:
        location.timezone = body.timezone
    if body.active is not None:
        location.active = body.active
    await db.commit()
    await db.refresh(location)
    return await to_out(db, location)


@router.delete("/{location_id}", status_code=204)
async def delete_location(
    location_id: uuid.UUID,
    user: UserContext = Depends(require_manage),
    db: AsyncSession = Depends(get_db),
):
    """Удалить точку можно, только пока к ней ничего не привязано.

    Если на точке были смены или сотрудники, удаление обнулило бы отчёты за
    прошлые месяцы, поэтому вместо него предлагается закрыть точку: из выбора
    в приложении она исчезнет, история останется.
    """
    location = await db.get(Location, location_id)
    if not location:
        raise HTTPException(404, "Точка не найдена")
    recorded = await db.scalar(
        select(DayRecording.id).where(DayRecording.location_id == location_id).limit(1)
    )
    if recorded:
        raise HTTPException(
            409,
            "На точке есть смены — её можно только закрыть, "
            "иначе прошлые отчёты потеряют студию",
        )
    staffed = await db.scalar(
        select(Employee.id).where(Employee.location_id == location_id).limit(1)
    )
    if staffed:
        raise HTTPException(
            409, "К точке привязаны сотрудники — сначала переведите их на другую точку"
        )
    await db.delete(location)
    await db.commit()
    return None
