"""Целостность сид-миграции 0002_seed_locales (Л.2 п.1) — данные, не
логика (см. test_services.py/test_selectors.py)."""

import pytest

from apps.l10n.models import Locale

pytestmark = pytest.mark.django_db


def test_en_seed_row_is_canonical_and_enabled():
    en = Locale.objects.get(code="en")
    assert en.name == "English"
    assert en.rtl is False
    assert en.enabled is True
    assert en.quality == Locale.Quality.CANONICAL


def test_ru_seed_row_is_reviewed_and_enabled():
    ru = Locale.objects.get(code="ru")
    assert ru.name == "Русский"
    assert ru.rtl is False
    assert ru.enabled is True
    assert ru.quality == Locale.Quality.REVIEWED
