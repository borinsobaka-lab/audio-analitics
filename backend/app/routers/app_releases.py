"""Обновление приложения записи.

Приложение стоит на компьютерах в студиях, куда владелец не ходит. Раньше
обновление означало собрать сборку, принести её на флешке и обойти точки.
Теперь приложение само спрашивает у сервера, нет ли версии новее, и ставит её
по нажатию кнопки «Обновить».

Безопасность держится не на этом сервере. Каждая сборка подписана приватным
ключом владельца, а публичный ключ вшит в приложение: даже если ответ сервера
подменят, приложение не установит чужой архив — подпись не сойдётся. Поэтому
подпись хранится рядом со сборкой и отдаётся вместе с ней.
"""
import io
import plistlib
import re
import tarfile
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import storage
from ..auth import UserContext, require_app, require_manage
from ..db import get_db
from ..models import AppRelease, Organization
from ..schemas import AppReleaseOut, UpdateManifest

router = APIRouter(prefix="/api/app", tags=["app"])

PLATFORMS = ("darwin", "windows", "linux")
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+")
MAX_ARCHIVE_MB = 300


def version_key(version: str) -> tuple:
    """Версия как кортеж чисел для сравнения: «0.10.0» новее «0.9.0».

    Сравнение строк здесь врёт именно на таком переходе, а это ровно тот
    момент, когда обновление молча перестанет приходить.
    """
    parts = re.split(r"[.\-+]", version.strip())
    numbers = []
    for part in parts:
        if part.isdigit():
            numbers.append(int(part))
        else:
            break
    return tuple(numbers) or (0,)


def version_from_archive(data: bytes) -> str | None:
    """Достать версию из Info.plist внутри .app.tar.gz.

    Версию можно было бы спрашивать у владельца полем в форме, но ошибка в
    ней ломает обновление незаметно: приложение будет либо считать себя
    новее сервера, либо ставить одно и то же по кругу. Пусть архив говорит
    за себя, а поле останется запасным вариантом.
    """
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
            for member in tar.getmembers():
                if not member.name.endswith("Contents/Info.plist"):
                    continue
                handle = tar.extractfile(member)
                if handle is None:
                    continue
                plist = plistlib.loads(handle.read())
                version = plist.get("CFBundleShortVersionString") or plist.get(
                    "CFBundleVersion"
                )
                if version:
                    return str(version)
    except Exception:  # noqa: BLE001 — битый архив не должен ронять загрузку
        return None
    return None


def to_out(release: AppRelease) -> AppReleaseOut:
    return AppReleaseOut.model_validate(release)


@router.get("/update/{platform}/{arch}/{current_version}")
async def check_update(
    platform: str,
    arch: str,
    current_version: str,
    _: None = Depends(require_app),
    db: AsyncSession = Depends(get_db),
):
    """Ответ апдейтеру Tauri: 204 — обновлять нечего, 200 с манифестом — есть.

    Архитектура (`arch`) в ответе не участвует: под macOS собирается один
    универсальный бандл на Intel и Apple Silicon, поэтому обеим машинам
    отдаётся один и тот же архив.
    """
    releases = (
        await db.scalars(
            select(AppRelease).where(
                AppRelease.platform == platform, AppRelease.published.is_(True)
            )
        )
    ).all()
    if not releases:
        return Response(status_code=204)

    latest = max(releases, key=lambda r: version_key(r.version))
    if version_key(latest.version) <= version_key(current_version):
        return Response(status_code=204)

    return UpdateManifest(
        version=latest.version,
        notes=latest.notes,
        pub_date=latest.created_at,
        # Ссылка временная: архив лежит в закрытом бакете, публичного адреса
        # у него нет.
        url=storage.presigned_get_url(latest.archive_uri),
        signature=latest.signature,
    )


@router.get("/releases", response_model=list[AppReleaseOut])
async def list_releases(
    user: UserContext = Depends(require_manage),
    db: AsyncSession = Depends(get_db),
):
    rows = await db.scalars(select(AppRelease).order_by(AppRelease.created_at.desc()))
    return [to_out(r) for r in rows]


@router.post("/releases", response_model=AppReleaseOut, status_code=201)
async def upload_release(
    archive: UploadFile = File(..., description="Audio Recorder.app.tar.gz"),
    signature_file: UploadFile | None = File(default=None, description="…tar.gz.sig"),
    signature: str = Form(default=""),
    version: str = Form(default=""),
    platform: str = Form(default="darwin"),
    notes: str = Form(default=""),
    user: UserContext = Depends(require_manage),
    db: AsyncSession = Depends(get_db),
):
    if platform not in PLATFORMS:
        raise HTTPException(400, f"Неизвестная платформа «{platform}»")

    data = await archive.read()
    if not data:
        raise HTTPException(400, "Пустой файл сборки")
    if len(data) > MAX_ARCHIVE_MB * 1024 * 1024:
        raise HTTPException(413, f"Сборка больше {MAX_ARCHIVE_MB} МБ")

    signature_text = signature.strip()
    if signature_file is not None:
        signature_text = (await signature_file.read()).decode("utf-8", "ignore").strip()
    if not signature_text:
        raise HTTPException(
            400,
            "Нет подписи: приложите файл .tar.gz.sig, который лежит рядом со сборкой",
        )

    resolved = version_from_archive(data) or version.strip()
    if not VERSION_RE.match(resolved):
        raise HTTPException(
            400,
            "Не удалось определить версию сборки — укажите её вручную в виде 1.2.3",
        )

    org = await db.scalar(select(Organization).limit(1))
    if not org:
        raise HTTPException(400, "Организация не создана — выполните seed")

    duplicate = await db.scalar(
        select(AppRelease).where(
            AppRelease.platform == platform, AppRelease.version == resolved
        )
    )
    if duplicate:
        raise HTTPException(
            409,
            f"Версия {resolved} уже выложена. Поднимите номер версии в "
            "tauri.conf.json и соберите заново — иначе приложения не увидят "
            "обновление.",
        )

    key = f"app-releases/{platform}/{resolved}/app.tar.gz"
    storage.upload_bytes(key, data, content_type="application/gzip")

    release = AppRelease(
        org_id=org.id,
        platform=platform,
        version=resolved,
        notes=notes.strip(),
        archive_uri=key,
        signature=signature_text,
        size_bytes=len(data),
        published=True,
        created_by_name=user.full_name or ("Владелец" if user.is_owner else ""),
    )
    db.add(release)
    await db.commit()
    await db.refresh(release)
    return to_out(release)


@router.patch("/releases/{release_id}", response_model=AppReleaseOut)
async def update_release(
    release_id: uuid.UUID,
    published: bool | None = None,
    notes: str | None = None,
    user: UserContext = Depends(require_manage),
    db: AsyncSession = Depends(get_db),
):
    release = await db.get(AppRelease, release_id)
    if not release:
        raise HTTPException(404, "Сборка не найдена")
    if published is not None:
        release.published = published
    if notes is not None:
        release.notes = notes.strip()
    await db.commit()
    await db.refresh(release)
    return to_out(release)


@router.delete("/releases/{release_id}", status_code=204)
async def delete_release(
    release_id: uuid.UUID,
    user: UserContext = Depends(require_manage),
    db: AsyncSession = Depends(get_db),
):
    release = await db.get(AppRelease, release_id)
    if not release:
        raise HTTPException(404, "Сборка не найдена")
    await db.delete(release)
    await db.commit()
    try:
        storage.delete_prefix(release.archive_uri)
    except Exception:  # noqa: BLE001 — хранилище не должно блокировать удаление
        pass
    return None
