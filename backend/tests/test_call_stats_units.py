"""Аналитика сценария звонка: воронка и где заканчивались звонки."""
from datetime import datetime, timedelta, timezone

from app.routers.playbook_calls import Run, aggregate

NOW = datetime(2026, 10, 5, 12, 0, tzinfo=timezone.utc)

NODES = [
    {"id": "greet", "title": "Приветствие", "group": "main", "answers": [{"label": "Да", "to": "goal"}]},
    {"id": "goal", "title": "Цель", "group": "main", "answers": [{"label": "Да", "to": "booked"}]},
    {"id": "booked", "title": "Запись", "group": "main", "answers": []},
    {"id": "obj_price", "title": "Сколько стоит", "group": "objection", "answers": [{"label": "Ок", "to": "goal"}]},
]


def run(ids, ended=True, minutes_ago=60):
    return Run(
        path=[{"id": i, "title": i, "group": "objection" if i.startswith("obj") else "main"} for i in ids],
        ended=ended,
        updated_at=NOW - timedelta(minutes=minutes_ago),
    )


def sample():
    return [
        run(["greet", "goal", "booked"]),             # дошёл до конца
        run(["greet", "goal", "obj_price"]),           # закончился на возражении
        run(["greet"], ended=False),                   # брошен давно — считается
        run(["greet", "goal"], ended=False, minutes_ago=5),  # идёт сейчас — не считается
    ]


def test_funnel_and_totals():
    out = aggregate(sample(), NODES, NOW)
    t = out["totals"]
    assert (t.runs, t.completed) == (3, 1)
    assert abs(t.avg_steps - 7 / 3) < 1e-9
    funnel = {s.node_id: (s.reached, s.ended_here) for s in out["funnel"]}
    assert list(funnel) == ["greet", "goal", "booked"]  # только этапы, по порядку
    assert funnel == {"greet": (3, 1), "goal": (2, 0), "booked": (1, 1)}


def test_ends_mark_script_end_and_objections():
    ends = {e.node_id: e for e in aggregate(sample(), NODES, NOW)["ends"]}
    assert ends["booked"].script_end and ends["booked"].count == 1
    assert not ends["obj_price"].script_end and ends["obj_price"].group == "objection"
    assert not ends["greet"].script_end
    assert "goal" not in ends  # идущий звонок не считается


def test_deleted_script_nodes_are_not_script_ends():
    nodes = [{"id": "greet", "title": "Приветствие", "group": "main"}]
    (end,) = aggregate([run(["greet"])], nodes, NOW)["ends"]
    assert not end.script_end
