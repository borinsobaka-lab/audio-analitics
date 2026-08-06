"""Editable LLM prompts (the key customization surface for analysis quality).

Editing never overwrites history: saving creates a new version and marks it
active. The pipeline always loads the active version by key at run time, so a
saved prompt applies to the next processed day without redeploy.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import UserContext, require_user
from ..db import get_db
from ..models import PromptTemplate, ScriptTemplate
from ..schemas import (
    PromptTemplateOut,
    PromptTemplateUpdate,
    ScriptTemplateOut,
    ScriptTemplateUpdate,
)

router = APIRouter(prefix="/api/prompts", tags=["prompts"])

PROMPT_KEYS = ("dialog_segmentation", "sale_analysis", "daily_summary")


@router.get("", response_model=list[PromptTemplateOut])
async def list_active_prompts(
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    q = (
        select(PromptTemplate)
        .where(PromptTemplate.active.is_(True))
        .order_by(PromptTemplate.key)
    )
    return (await db.scalars(q)).all()


@router.get("/{key}/versions", response_model=list[PromptTemplateOut])
async def prompt_history(
    key: str,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    q = (
        select(PromptTemplate)
        .where(PromptTemplate.key == key)
        .order_by(PromptTemplate.version.desc())
    )
    items = (await db.scalars(q)).all()
    if not items:
        raise HTTPException(404, f"No prompt with key '{key}'")
    return items


@router.put("/{key}", response_model=PromptTemplateOut)
async def save_prompt(
    key: str,
    body: PromptTemplateUpdate,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    current = await db.scalar(
        select(PromptTemplate)
        .where(PromptTemplate.key == key, PromptTemplate.active.is_(True))
        .order_by(PromptTemplate.version.desc())
    )
    if not current:
        raise HTTPException(404, f"No prompt with key '{key}' (seed defaults first)")

    await db.execute(
        update(PromptTemplate)
        .where(PromptTemplate.key == key, PromptTemplate.org_id == current.org_id)
        .values(active=False)
    )
    new = PromptTemplate(
        org_id=current.org_id,
        key=key,
        name=body.name or current.name,
        description=body.description if body.description is not None else current.description,
        content=body.content,
        model=body.model if body.model is not None else current.model,
        version=current.version + 1,
        active=True,
        updated_by=user.email or user.user_id,
    )
    db.add(new)
    await db.commit()
    await db.refresh(new)
    return new


@router.post("/{key}/rollback/{version}", response_model=PromptTemplateOut)
async def rollback_prompt(
    key: str,
    version: int,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Re-activate an older version as a new version (history stays linear)."""
    target = await db.scalar(
        select(PromptTemplate).where(
            PromptTemplate.key == key, PromptTemplate.version == version
        )
    )
    if not target:
        raise HTTPException(404, "Version not found")
    return await save_prompt(
        key,
        PromptTemplateUpdate(
            content=target.content,
            name=target.name,
            description=target.description,
            model=target.model,
        ),
        user,
        db,
    )


# --- Sales script (referenced by the sale_analysis prompt as {{script}}) ---

script_router = APIRouter(prefix="/api/script", tags=["script"])


@script_router.get("", response_model=ScriptTemplateOut)
async def get_active_script(
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    script = await db.scalar(
        select(ScriptTemplate)
        .where(ScriptTemplate.active.is_(True))
        .order_by(ScriptTemplate.version.desc())
    )
    if not script:
        raise HTTPException(404, "No active script template (seed defaults first)")
    return script


@script_router.put("", response_model=ScriptTemplateOut)
async def save_script(
    body: ScriptTemplateUpdate,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    current = await db.scalar(
        select(ScriptTemplate)
        .where(ScriptTemplate.active.is_(True))
        .order_by(ScriptTemplate.version.desc())
    )
    if not current:
        raise HTTPException(404, "No active script template (seed defaults first)")

    await db.execute(
        update(ScriptTemplate)
        .where(ScriptTemplate.org_id == current.org_id)
        .values(active=False)
    )
    new = ScriptTemplate(
        org_id=current.org_id,
        version=current.version + 1,
        name=body.name or current.name,
        stages_json=(
            [s.model_dump() for s in body.stages]
            if body.stages is not None
            else current.stages_json
        ),
        body=body.body if body.body is not None else current.body,
        active=True,
    )
    db.add(new)
    await db.commit()
    await db.refresh(new)
    return new
