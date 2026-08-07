"""Пароли, сессии и область видимости — без сети и без базы."""
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.auth import UserContext
from app.security import (
    generate_password,
    hash_password,
    issue_session,
    normalize_login,
    read_session,
    verify_password,
)


# --- пароли ---

def test_password_roundtrip():
    password = generate_password()
    stored = hash_password(password)
    assert password not in stored  # в базе только хеш
    assert verify_password(password, stored)
    assert not verify_password(password + "x", stored)


def test_hash_is_salted():
    """Два одинаковых пароля дают разные хеши, иначе по совпадению строк
    видно, у кого пароль такой же."""
    assert hash_password("one-two-three") != hash_password("one-two-three")


def test_verify_rejects_garbage():
    for stored in (None, "", "не-хеш", "md5$1$a$b"):
        assert not verify_password("whatever", stored)


def test_generated_password_avoids_lookalikes():
    """Пароль диктуют голосом: «l» против «1» и «O» против «0» — это звонок
    «не пускает»."""
    joined = "".join(generate_password() for _ in range(50))
    assert not set(joined) & set("lo01ILO")


# --- сессии ---

def test_session_roundtrip():
    employee_id = uuid.uuid4()
    changed = datetime.now(timezone.utc)
    payload = read_session(issue_session(employee_id, changed))
    assert payload["sub"] == str(employee_id)
    assert payload["pw"] == int(changed.timestamp())


def test_session_carries_password_moment():
    """Сброс пароля меняет момент выдачи — по нему старая сессия и отсекается."""
    employee_id = uuid.uuid4()
    before = datetime.now(timezone.utc)
    after = before + timedelta(minutes=1)
    old = read_session(issue_session(employee_id, before))
    assert old["pw"] != int(after.timestamp())


def test_broken_token_is_not_a_session():
    assert read_session("не токен") is None


def test_login_is_case_insensitive():
    assert normalize_login("  Anna ") == "anna"


# --- область видимости ---

def make(scope: str, employee_id=None) -> UserContext:
    return UserContext(user_id="u", employee_id=employee_id, scope=scope)


def test_all_scope_sees_everyone():
    user = make("all")
    assert user.can_view_all and user.can_manage
    assert user.may_see_employee(uuid.uuid4())
    assert user.may_see_employee(None)


def test_own_scope_sees_only_itself():
    mine = uuid.uuid4()
    user = make("own", mine)
    assert not user.can_view_all and not user.can_manage
    assert user.may_see_employee(mine)
    assert not user.may_see_employee(uuid.uuid4())


def test_own_scope_does_not_see_unassigned_shifts():
    """Смена без менеджера видна только администратору: иначе её увидел бы
    каждый, кому открыт «только свой» доступ."""
    assert not make("own", uuid.uuid4()).may_see_employee(None)


def test_author_key_distinguishes_owner_and_employee():
    employee_id = uuid.uuid4()
    assert make("own", employee_id).author_key == f"emp:{employee_id}"
    assert make("all").author_key == "owner"
