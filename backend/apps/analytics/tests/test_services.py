"""Пересчёт витрин (§8.3), слой конструктора (§8.1) и воронка установки (ADR-171)."""

from __future__ import annotations

import datetime as dt

import pytest
from django.test import override_settings
from django.utils import timezone

from apps.analytics import services
from apps.analytics.models import ConstructorStepEvent, InstallEvent, MartRefreshRun

pytestmark = pytest.mark.django_db(databases=["default", "audit"])


def test_refresh_marts_runs_in_documented_order() -> None:
    """✅ Дневная витрина считается ПОВЕРХ жизненного цикла и когорт (§8.3),
    поэтому порядок — часть контракта, а не деталь реализации."""
    results = services.refresh_marts()
    assert [r.mart for r in results] == list(services.MART_ORDER)
    assert all(r.ok for r in results), [r.error for r in results if not r.ok]


def test_refresh_records_every_run() -> None:
    """✅ Витрина, которая молча перестала пересчитываться, хуже
    отсутствующей: по ней принимают решения, считая её свежей."""
    services.refresh_mart("mart_user_cohorts")
    run = MartRefreshRun.objects.filter(mart="mart_user_cohorts").first()
    assert run is not None
    assert run.ok is True
    assert run.finished_at >= run.started_at


def test_refresh_records_failure_without_raising(monkeypatch: pytest.MonkeyPatch) -> None:
    """✅ Провал одной витрины не роняет beat, но и не маскируется."""
    monkeypatch.setattr(services, "_read_sql", lambda mart: "SELECT * FROM no_such_table")
    result = services.refresh_mart("mart_user_cohorts")
    assert result.ok is False
    run = MartRefreshRun.objects.filter(mart="mart_user_cohorts", ok=False).first()
    assert run is not None
    assert run.error


def test_refresh_unknown_mart_rejected() -> None:
    """🚫 Имя витрины — из закрытого списка: SQL-файл читается по имени."""
    with pytest.raises(ValueError):
        services.refresh_mart("../../etc/passwd")


def test_record_constructor_step_stores_no_personal_data() -> None:
    """✅ §8.1: в слое только форма — код шага, действие, черновик.
    Ни пользователя, ни IP, ни значений полей формы в модели нет вовсе."""
    event = services.record_constructor_step(step_code="parties", action="left")
    assert event.step_code == "parties"
    field_names = {f.name for f in ConstructorStepEvent._meta.get_fields()}
    assert not (field_names & {"user", "user_id", "ip", "payload", "form_data"})


def test_record_constructor_step_rejects_unknown_action() -> None:
    """🚫 Действие — из перечисления, а не произвольная строка."""
    with pytest.raises(ValueError):
        services.record_constructor_step(step_code="parties", action="rage_quit")


@override_settings(ANALYTICS_CONSTRUCTOR_RETENTION_DAYS=90)
def test_purge_constructor_events_respects_retention() -> None:
    """✅ Хранение 90 дней — условие, на котором слой заведён (§8.1),
    а не уборка по настроению."""
    now = timezone.now()
    services.record_constructor_step(
        step_code="old", action="left", occurred_at=now - dt.timedelta(days=120)
    )
    services.record_constructor_step(
        step_code="fresh", action="left", occurred_at=now - dt.timedelta(days=10)
    )
    assert services.purge_constructor_step_events() == 1
    assert list(ConstructorStepEvent.objects.values_list("step_code", flat=True)) == ["fresh"]


# --------------------------------------------------------------------------
# Воронка установки приложения (ADR-171)
# --------------------------------------------------------------------------
def test_record_install_event_stores_no_personal_data() -> None:
    """✅ В событии установки нет ни UA, ни IP, ни отпечатка устройства."""
    event = services.record_install_event(kind="pwa_installed", platform="android")
    assert (event.kind, event.platform) == ("pwa_installed", "android")
    assert event.user_id is None
    fields = {f.name for f in InstallEvent._meta.get_fields()}
    assert not (fields & {"user_agent", "ip", "device_fingerprint", "session_id"})


def test_record_install_event_rejects_unknown_kind() -> None:
    """🚫 Набор видов закрыт — произвольное событие не записать."""
    with pytest.raises(ValueError):
        services.record_install_event(kind="rage_click")


def test_record_install_event_falls_back_to_least_claiming_values() -> None:
    """✅ Мусор в необязательных полях не роняет запись и не превращается в
    утверждение: неизвестная платформа — «прочее», а не выдумка."""
    event = services.record_install_event(kind="install_click", platform="SM-S908B")
    assert event.platform == "other"


def test_purge_install_events_respects_retention() -> None:
    """✅ Хранение 90 дней — условие, на котором слой заведён; у событий
    установки есть user_id, поэтому срок здесь не формальность."""
    fresh = services.record_install_event(kind="install_click")
    old = services.record_install_event(kind="install_click")
    InstallEvent.objects.filter(pk=old.pk).update(
        created_at=timezone.now() - dt.timedelta(days=200)
    )
    assert services.purge_install_events() == 1
    assert list(InstallEvent.objects.values_list("pk", flat=True)) == [fresh.pk]
