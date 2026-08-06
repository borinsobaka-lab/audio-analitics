"""Managers (employees) administration for the dashboard.

Deactivating never deletes: past reports must keep pointing at the person who
recorded them, so a deactivated manager only disappears from the app's picker.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import UserContext, require_user
from ..db import get_db
from ..models import Employee, Location
from ..schemas import EmployeeCreate, EmployeeOut, EmployeeUpdate

router = APIRouter(prefix="/api/employees", tags=["employees"])


async def default_location(db: AsyncSession) -> Location:
    location = await db.scalar(select(Location).order_by(Location.name).limit(1))
    if not location:
        raise HTTPException(400, "Не создано ни одной точки — выполните seed")
    return location


@router.get("", response_model=list[EmployeeOut])
async def list_employees(
    include_inactive: bool = True,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    q = select(Employee).order_by(Employee.active.desc(), Employee.full_name)
    if not include_inactive:
        q = q.where(Employee.active.is_(True))
    return (await db.scalars(q)).all()


@router.post("", response_model=EmployeeOut, status_code=201)
async def create_employee(
    body: EmployeeCreate,
    user: UserContext = Depends(require_user),
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

    employee = Employee(
        org_id=location.org_id,
        location_id=location.id,
        full_name=name,
        role=body.role or "manager",
        active=True,
    )
    db.add(employee)
    await db.commit()
    await db.refresh(employee)
    return employee


@router.patch("/{employee_id}", response_model=EmployeeOut)
async def update_employee(
    employee_id: uuid.UUID,
    body: EmployeeUpdate,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    employee = await db.get(Employee, employee_id)
    if not employee:
        raise HTTPException(404, "Менеджер не найден")
    if body.full_name is not None:
        employee.full_name = body.full_name.strip()
    if body.active is not None:
        employee.active = body.active
    await db.commit()
    await db.refresh(employee)
    return employee
