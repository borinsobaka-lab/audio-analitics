"""Договорённости по итогам разбора смены.

Разбор, после которого ничего не записано, забывается к вечеру. Здесь
фиксируется, о чём условились с менеджером после конкретной смены — при
желании со ссылкой на разговор, из-за которого разговор и зашёл.

Дальше работает главное: в карточке следующей смены того же менеджера
незакрытые договорённости показываются сверху с вопросом «сделали?».
Никто не должен помнить о проверке — она сама всплывает в нужный день, и
там же отмечается «выполнено» или «не получилось».
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..access import visible_day
from ..auth import UserContext, require_user
from ..db import get_db
from ..models import Agreement, DayRecording, Dialog, Employee, utcnow
from ..schemas import AgreementCreate, AgreementOut, AgreementUpdate

router = APIRouter(prefix="/api/agreements", tags=["agreements"])

OPEN = "open"


async def agreements_of_day(
    db: AsyncSession, recording_id: uuid.UUID
) -> list[AgreementOut]:
    rows = await db.scalars(
        select(Agreement)
        .where(Agreement.day_recording_id == recording_id)
        .order_by(Agreement.created_at)
    )
    return [AgreementOut.model_validate(r) for r in rows]


async def carried_agreements(
    db: AsyncSession, rec: DayRecording
) -> list[AgreementOut]:
    """Что осталось незакрытым с прошлых смен этого менеджера.

    Только более ранние смены: договорённость, записанная сегодня, не должна
    в тот же день показываться как «долг с прошлого раза».
    """
    if not rec.employee_id:
        return []
    rows = await db.scalars(
        select(Agreement)
        .where(
            Agreement.employee_id == rec.employee_id,
            Agreement.status == OPEN,
            Agreement.day_date < rec.date,
        )
        .order_by(Agreement.day_date.desc(), Agreement.created_at)
    )
    return [AgreementOut.model_validate(r) for r in rows]


@router.get("", response_model=list[AgreementOut])
async def list_agreements(
    status: str | None = Query(default=None, pattern="^(open|done|missed|cancelled)$"),
    employee_id: uuid.UUID | None = None,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    q = select(Agreement).order_by(Agreement.day_date.desc(), Agreement.created_at.desc())
    if status:
        q = q.where(Agreement.status == status)
    if employee_id:
        q = q.where(Agreement.employee_id == employee_id)
    if not user.can_view_all:
        q = q.where(Agreement.employee_id == user.employee_id)
    return [AgreementOut.model_validate(r) for r in await db.scalars(q.limit(300))]


@router.post("", response_model=AgreementOut, status_code=201)
async def create_agreement(
    body: AgreementCreate,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    rec = await visible_day(db, body.day_recording_id, user)

    dialog_start = None
    if body.dialog_id:
        dialog = await db.get(Dialog, body.dialog_id)
        if not dialog or dialog.day_recording_id != rec.id:
            raise HTTPException(404, "Разговор не найден в этой смене")
        dialog_start = dialog.start_s

    employee_name = ""
    if rec.employee_id:
        employee = await db.get(Employee, rec.employee_id)
        employee_name = employee.full_name if employee else ""

    row = Agreement(
        org_id=rec.org_id,
        employee_id=rec.employee_id,
        employee_name=employee_name,
        day_recording_id=rec.id,
        day_date=rec.date,
        dialog_id=body.dialog_id,
        dialog_start_s=dialog_start,
        text=body.text.strip(),
        status=OPEN,
        created_by_employee_id=user.employee_id,
        created_by_name=user.full_name or ("Владелец" if user.is_owner else ""),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return AgreementOut.model_validate(row)


@router.patch("/{agreement_id}", response_model=AgreementOut)
async def update_agreement(
    agreement_id: uuid.UUID,
    body: AgreementUpdate,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(Agreement, agreement_id)
    if not row:
        raise HTTPException(404, "Договорённость не найдена")
    if not user.may_see_employee(row.employee_id):
        raise HTTPException(404, "Договорённость не найдена")

    # Итог подводит тот, кто ведёт разбор: иначе «выполнено» ставит себе сам
    # тот, кого проверяют, и проверка теряет смысл.
    if (body.status is not None or body.text is not None) and not user.can_view_all:
        raise HTTPException(403, "Отмечать итог договорённости может администратор")

    if body.text is not None:
        row.text = body.text.strip()
    if body.resolution_note is not None:
        row.resolution_note = body.resolution_note.strip()
    if body.status is not None and body.status != row.status:
        row.status = body.status
        if body.status == OPEN:
            row.resolved_at = None
            row.resolved_by_name = ""
            row.resolved_day_recording_id = None
        else:
            row.resolved_at = utcnow()
            row.resolved_by_name = user.full_name or "Владелец"
            if body.resolved_day_recording_id:
                marked_on = await visible_day(db, body.resolved_day_recording_id, user)
                row.resolved_day_recording_id = marked_on.id

    await db.commit()
    await db.refresh(row)
    return AgreementOut.model_validate(row)


@router.delete("/{agreement_id}", status_code=204)
async def delete_agreement(
    agreement_id: uuid.UUID,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(Agreement, agreement_id)
    if not row:
        raise HTTPException(404, "Договорённость не найдена")
    mine = row.created_by_employee_id == user.employee_id and user.employee_id
    if not user.can_view_all and not mine:
        raise HTTPException(403, "Недостаточно прав")
    await db.delete(row)
    await db.commit()
    return None


@router.get("/open-count")
async def open_count(
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Сколько договорённостей ждут проверки — для отметки в меню."""
    q = select(Agreement.id).where(Agreement.status == OPEN)
    if not user.can_view_all:
        q = q.where(Agreement.employee_id == user.employee_id)
    return {"open": len((await db.scalars(q)).all())}
