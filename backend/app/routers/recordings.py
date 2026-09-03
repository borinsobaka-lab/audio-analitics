"""Endpoints used by the desktop recorder client (device-key auth)."""
import uuid

from fastapi import APIRouter, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import Depends

from .. import storage
from ..auth import DeviceContext, require_app, require_device
from ..db import get_db
from ..models import AudioSegment, DayRecording, Employee, Location
from ..schemas import (
    DayFinishRequest,
    DayRecordingOut,
    DayStartRequest,
    EmployeePickOut,
    LocationPickOut,
    SegmentUploadedOut,
)

router = APIRouter(prefix="/api/recordings", tags=["recordings"])


@router.get("/locations", response_model=list[LocationPickOut])
async def list_pickable_locations(
    _: None = Depends(require_app),
    db: AsyncSession = Depends(get_db),
):
    """Список точек продажи для настройки приложения.

    Отвечает на ключ приложения, без привязки к точке: приложение только что
    установили, и точку как раз предстоит выбрать. Наружу отдаются имя и
    адрес — по ним сотрудник узнаёт свою студию.
    """
    q = select(Location).where(Location.active.is_(True)).order_by(Location.name)
    return (await db.scalars(q)).all()


@router.get("/employees", response_model=list[EmployeePickOut])
async def list_pickable_employees(
    device: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
):
    """Все активные менеджеры — независимо от выбранной точки продажи.

    Сотрудник не закреплён за студией: сегодня он на Ваке, завтра подменяет
    на Сабуртало, и заводить его дважды или переназначать перед сменой никто
    не будет. Смена всё равно достаётся той точке, на которой стоит компьютер:
    студия берётся из устройства, а не из карточки человека.
    """
    q = (
        select(Employee)
        .where(Employee.active.is_(True))
        .order_by(Employee.full_name)
    )
    return (await db.scalars(q)).all()


@router.post("/start", response_model=DayRecordingOut)
async def start_day(
    body: DayStartRequest,
    device: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
):
    """Resume the session still in progress, otherwise open a new one.

    Only a recording that is still in the `recording` state is resumed — that
    is the app-restarted-after-a-crash case. A day that was already finished
    stays untouched and a second session gets its own recording and report.
    """
    location = await db.get(Location, device.location_id)
    if not location:
        raise HTTPException(404, "Location not found")

    if body.employee_id:
        # Проверяем только существование: к точке менеджер не привязан и может
        # выйти на любой студии.
        if not await db.get(Employee, body.employee_id):
            raise HTTPException(404, "Менеджер не найден")

    in_progress = await db.scalar(
        select(DayRecording)
        .where(
            DayRecording.location_id == device.location_id,
            DayRecording.date == body.date,
            DayRecording.status == "recording",
        )
        .order_by(DayRecording.created_at.desc())
    )
    if in_progress:
        # Let a resumed session pick up the manager chosen on restart.
        if body.employee_id and in_progress.employee_id != body.employee_id:
            in_progress.employee_id = body.employee_id
            await db.commit()
            await db.refresh(in_progress)
        return in_progress

    rec = DayRecording(
        org_id=location.org_id,
        location_id=device.location_id,
        employee_id=body.employee_id,
        date=body.date,
        status="recording",
    )
    db.add(rec)
    await db.commit()
    await db.refresh(rec)
    return rec


@router.put("/{recording_id}/segments/{idx}", response_model=SegmentUploadedOut)
async def upload_segment(
    recording_id: uuid.UUID,
    idx: int,
    file: UploadFile,
    device: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
):
    """Idempotent chunk upload: re-uploading the same idx overwrites the object."""
    rec = await db.get(DayRecording, recording_id)
    if not rec or rec.location_id != device.location_id:
        raise HTTPException(404, "Recording not found")
    if rec.status not in ("recording", "uploaded"):
        raise HTTPException(409, f"Recording is in status {rec.status}")

    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    key = storage.segment_key(str(recording_id), idx)
    storage.upload_bytes(key, data, content_type="audio/ogg")

    existing = await db.scalar(
        select(AudioSegment).where(
            AudioSegment.day_recording_id == recording_id, AudioSegment.idx == idx
        )
    )
    if existing:
        return SegmentUploadedOut(id=existing.id, idx=idx)

    seg = AudioSegment(day_recording_id=recording_id, idx=idx, audio_uri=key)
    db.add(seg)
    await db.commit()
    await db.refresh(seg)
    return SegmentUploadedOut(id=seg.id, idx=idx)


@router.post("/{recording_id}/finish", response_model=DayRecordingOut)
async def finish_day(
    recording_id: uuid.UUID,
    body: DayFinishRequest,
    device: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
):
    """Смена закрыта в приложении: сегменты на месте, разбор не запускается.

    Запуск теперь отдельным нажатием в админке. Автоматический разбор всего
    подряд обходился в деньги на пустых днях, неудачных дублях и проверках
    оборудования; владелец сам решает, какую смену стоит разобрать.
    """
    rec = await db.get(DayRecording, recording_id)
    if not rec or rec.location_id != device.location_id:
        raise HTTPException(404, "Recording not found")
    if rec.status == "uploaded":
        # Повторное «завершить» (приложение не дождалось ответа) — уже сделано.
        return rec
    if rec.status != "recording":
        # Смену уже закрыли из админки и разобрали: опоздавший запрос не должен
        # откатывать «готово» обратно в «ждёт разбора». Приложение по 409
        # понимает, что дозагружать больше нечего.
        raise HTTPException(409, f"Смена уже закрыта, статус «{rec.status}»")

    count = len(
        (
            await db.scalars(
                select(AudioSegment).where(AudioSegment.day_recording_id == recording_id)
            )
        ).all()
    )
    if count < body.total_segments:
        raise HTTPException(
            409, f"Only {count}/{body.total_segments} segments uploaded; retry missing ones"
        )

    rec.set_status("uploaded", "запись завершена, ждёт запуска разбора")
    await db.commit()
    await db.refresh(rec)
    return rec
