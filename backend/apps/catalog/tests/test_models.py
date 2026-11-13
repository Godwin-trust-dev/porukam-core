import pytest
from django.db import IntegrityError

from apps.catalog.models import ChecklistTemplatePickStat, Currency


@pytest.mark.django_db
def test_rub_is_seeded_and_active():
    rub = Currency.objects.get(pk="RUB")
    assert rub.is_active is True
    assert rub.symbol == "₽"
    assert rub.numeric_code == "643"
    assert rub.decimal_places == 2


@pytest.mark.django_db
def test_usd_and_eur_are_seeded_and_active():
    """ГВ.1 (docs/tasks/global-wave.md): «только RUB» снимается для
    GLOBAL-контура — 0007_seed_usd_eur активирует USD/EUR в справочнике."""
    usd = Currency.objects.get(pk="USD")
    eur = Currency.objects.get(pk="EUR")
    assert usd.is_active is True
    assert usd.numeric_code == "840"
    assert eur.is_active is True
    assert eur.numeric_code == "978"


@pytest.mark.django_db
def test_pick_stat_rejects_empty_slug():
    """БД-инвариант (живой PostgreSQL, ADR-153): статистика ведётся ТОЛЬКО
    по стабильному `slug` — пункты ручного сида 0006 (`slug=""`) в неё не
    попадают даже в обход сервисного слоя."""
    with pytest.raises(IntegrityError):
        ChecklistTemplatePickStat.objects.create(slug="", pick_count=1)


@pytest.mark.django_db
def test_pick_stat_slug_is_unique():
    """Один слаг — одна строка счётчика: на этом стоит «инкремент вместо
    вставки» в `services._increment_pick_count`."""
    ChecklistTemplatePickStat.objects.create(slug="renovation.turnkey.base.1", pick_count=1)
    with pytest.raises(IntegrityError):
        ChecklistTemplatePickStat.objects.create(slug="renovation.turnkey.base.1", pick_count=1)
