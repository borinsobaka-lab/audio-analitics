"""Сценарий звонка: стартовый файл и проверка схемы."""
import pytest
from pydantic import ValidationError

from app.routers.playbook import blank_flow, default_call_section
from app.schemas import CallFlow


def test_default_call_section_is_valid_and_connected():
    call = default_call_section()
    flow = CallFlow.model_validate(call["flow"])
    ids = {n.id for n in flow.nodes}
    assert flow.start == "greet"
    # Каждый этап, кроме первого, достижим ответом из другого блока.
    targets = {a.to for n in flow.nodes for a in n.answers}
    for n in flow.nodes:
        if n.group == "main" and n.id != flow.start:
            assert n.id in targets, n.title
    # Возражения возвращают в разговор.
    for n in flow.nodes:
        if n.group == "objection" and n.answers:
            assert all(a.to in ids for a in n.answers)
    assert any(n.group == "objection" for n in flow.nodes)


def test_blank_flow_is_valid():
    flow = CallFlow.model_validate(blank_flow())
    assert len(flow.nodes) == 1 and flow.start == flow.nodes[0].id


def node(id, answers=()):
    return {"id": id, "title": id, "text": {"ru": "текст"}, "answers": [{"label": "да", "to": t} for t in answers]}


def test_broken_link_is_rejected():
    with pytest.raises(ValidationError, match="удалённый блок"):
        CallFlow.model_validate({"start": "a", "nodes": [node("a", ["b"])]})


def test_missing_start_and_duplicates_are_rejected():
    with pytest.raises(ValidationError, match="Первый блок"):
        CallFlow.model_validate({"start": "x", "nodes": [node("a")]})
    with pytest.raises(ValidationError, match="одинаковый id"):
        CallFlow.model_validate({"start": "a", "nodes": [node("a"), node("a")]})
