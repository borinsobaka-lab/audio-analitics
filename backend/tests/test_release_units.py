"""Сравнение версий приложения — то, на чём молча ломается автообновление."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.routers.app_releases import version_key


def test_newer_version_wins():
    assert version_key("0.2.0") > version_key("0.1.0")
    assert version_key("1.0.0") > version_key("0.9.9")


def test_double_digit_minor():
    """Строковое сравнение здесь врёт: «0.10.0» < «0.9.0» как текст. Это ровно
    тот переход, на котором обновления молча перестали бы приходить."""
    assert version_key("0.10.0") > version_key("0.9.0")
    assert version_key("0.2.10") > version_key("0.2.9")


def test_same_version_is_not_newer():
    assert not version_key("1.2.3") > version_key("1.2.3")


def test_suffix_is_ignored():
    """Хвосты вроде «1.2.3-beta» сравниваются по числовой части: свой релиз
    мы всё равно нумеруем тремя числами."""
    assert version_key("1.2.3-beta") == (1, 2, 3)


def test_garbage_does_not_crash():
    assert version_key("") == (0,)
    assert version_key("не версия") == (0,)
