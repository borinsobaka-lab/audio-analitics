"""Owner-defined analysis metrics (name + prompt + scale).

Every active metric is applied to every client dialog during day processing.
Deleting a metric also deletes its evaluations in past reports; deactivating
keeps history and only excludes the metric from future processing.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import UserContext, require_user
from ..db import get_db
from ..models import AnalysisMetric, MetricEvaluation, Organization
from ..schemas import MetricCreate, MetricOut, MetricUpdate

router = APIRouter(prefix="/api/metrics", tags=["metrics"])


@router.get("", response_model=list[MetricOut])
async def list_metrics(
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    q = select(AnalysisMetric).order_by(AnalysisMetric.position, AnalysisMetric.created_at)
    return (await db.scalars(q)).all()


@router.post("", response_model=MetricOut, status_code=201)
async def create_metric(
    body: MetricCreate,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    org = await db.scalar(select(Organization).limit(1))
    if not org:
        raise HTTPException(400, "Организация не создана — выполните seed")
    max_position = await db.scalar(select(func.max(AnalysisMetric.position))) or 0
    metric = AnalysisMetric(
        org_id=org.id,
        name=body.name.strip(),
        prompt=body.prompt,
        scale_max=body.scale_max,
        active=True,
        position=max_position + 1,
    )
    db.add(metric)
    await db.commit()
    await db.refresh(metric)
    return metric


@router.patch("/{metric_id}", response_model=MetricOut)
async def update_metric(
    metric_id: uuid.UUID,
    body: MetricUpdate,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    metric = await db.get(AnalysisMetric, metric_id)
    if not metric:
        raise HTTPException(404, "Метрика не найдена")
    if body.name is not None:
        metric.name = body.name.strip()
    if body.prompt is not None:
        metric.prompt = body.prompt
    if body.scale_max is not None:
        metric.scale_max = body.scale_max
    if body.active is not None:
        metric.active = body.active
    if body.position is not None:
        metric.position = body.position
    await db.commit()
    await db.refresh(metric)
    return metric


@router.delete("/{metric_id}", status_code=204)
async def delete_metric(
    metric_id: uuid.UUID,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    metric = await db.get(AnalysisMetric, metric_id)
    if not metric:
        raise HTTPException(404, "Метрика не найдена")
    await db.execute(
        delete(MetricEvaluation).where(MetricEvaluation.metric_id == metric_id)
    )
    await db.delete(metric)
    await db.commit()
    return None
