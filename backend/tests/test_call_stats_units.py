"""Аналитика звонков: воронка, обрывы, возражения, администраторы."""
from datetime import datetime, timedelta, timezone

from app.routers.playbook_calls import Run, aggregate, classify

NOW = datetime(2026, 10, 5, 12, 0, tzinfo=timezone.utc)

NODES = [
    {"id": "greet", "title": "Приветствие", "group": "main"},
    {"id": "goal", "title": "Цель", "group": "main"},
    {"id": "day", "title": "День", "group": "main"},
    {"id": "booked", "title": "Запись", "group": "main"},
    {"id": "obj_price", "title": "Сколько стоит", "group": "objection"},
]


def run(user, steps, outcome="", ended=True, minutes_ago=60, name=None):
    t0 = NOW - timedelta(minutes=minutes_ago)
    path = [
        {
            "id": s[0],
            "title": s[0],
            "group": "objection" if s[0].startswith("obj") else "main",
            "answer": s[1] if len(s) > 1 else "",
            "at": (t0 + timedelta(seconds=30 * i)).isoformat(),
        }
        for i, s in enumerate(steps)
    ]
    return Run(
        user_key=user,
        user_name=name or user,
        path=path,
        outcome=outcome,
        ended=ended,
        updated_at=t0 + timedelta(seconds=30 * len(steps)),
    )


def sample():
    return [
        run("a", [("greet", "Здравствуйте"), ("goal", "Шпагат"), ("day", "Пн"), ("booked",)], "booked"),
        run("a", [("greet", "Здравствуйте"), ("goal", "Похудеть"), ("obj_price", "Подобрать время"), ("day",)],
            ended=False),  # брошен на «День»
        run("b", [("greet", "Здравствуйте"), ("goal", "Шпагат"), ("obj_price",)], "refused"),
        run("b", [("greet",)], "no_answer"),
        run("b", [("greet", "Здравствуйте"), ("goal",)], ended=False, minutes_ago=5),  # идёт сейчас
    ]


def test_classify():
    runs = sample()
    assert [classify(r, NOW) for r in runs] == ["ended", "dropped", "ended", "ended", "live"]


def test_totals_and_conversion():
    out = aggregate(sample(), NODES, NOW)
    t = out["totals"]
    assert (t.runs, t.live, t.booked, t.refused, t.no_answer, t.no_outcome) == (5, 1, 1, 1, 1, 1)
    # Дозвонились: 5 − 1 идущий − 1 не дозвонились = 3; записан 1.
    assert abs(t.conversion - 1 / 3) < 1e-9
    assert t.avg_seconds is not None


def test_funnel_reach_and_drops():
    out = aggregate(sample(), NODES, NOW)
    funnel = {s.node_id: s for s in out["funnel"]}
    assert [s.node_id for s in out["funnel"]] == ["greet", "goal", "day", "booked"]
    # «Не дозвонились» — не разговор: в воронку не идёт.
    assert funnel["greet"].reached == 4
    assert funnel["goal"].reached == 4
    assert funnel["day"].reached == 2
    assert funnel["booked"].reached == 1
    # Обрывы без записи: «День» (брошен); отказ на возражении — не этап
    # воронки; идущий звонок и «не дозвонились» — не обрыв.
    assert funnel["day"].ended_here == 1
    assert funnel["greet"].ended_here == 0
    assert funnel["goal"].ended_here == 0
    assert funnel["greet"].median_seconds == 30
    goal_answers = {a.label: a.count for a in funnel["goal"].answers}
    assert goal_answers == {"Шпагат": 2, "Похудеть": 1}


def test_objections_and_ends():
    out = aggregate(sample(), NODES, NOW)
    (price,) = out["objections"]
    assert (price.runs, price.booked, price.ended_here) == (2, 0, 1)
    ends = {e.node_id: e for e in out["ends"]}
    assert ends["obj_price"].refused == 1 and ends["obj_price"].group == "objection"
    assert "greet" not in ends
    assert ends["day"].no_outcome == 1
    assert "booked" not in ends


def test_users_and_filter():
    out = aggregate(sample(), NODES, NOW, user_key="a")
    # Итоги — по выбранному администратору, список — по всем.
    assert out["totals"].runs == 2
    users = {u.user_key: u for u in out["users"]}
    assert set(users) == {"a", "b"}
    assert users["a"].booked == 1 and users["a"].conversion == 0.5
    assert users["a"].reach == {"greet": 2, "goal": 2, "day": 2, "booked": 1, "obj_price": 1}
    assert users["b"].top_drop is not None
    assert users["b"].reach["greet"] == 2  # без «не дозвонились»
    assert users["b"].conversion == 0.0


def test_jump_answers_are_not_client_answers():
    r = run("a", [("greet", "→ переход"), ("goal",)], "refused")
    out = aggregate([r], NODES, NOW)
    assert out["funnel"][0].answers == []
