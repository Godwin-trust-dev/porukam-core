"""Окно выгрузки 72 ч (ADR-053) / `lateness` (ADR-136 п.5) — чистая функция
`compute_lateness`, property-based (Hypothesis): три зоны + честное
«неизвестно»."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from apps.evidence import services
from apps.evidence.models import Evidence
from apps.milestones.models import Milestone

_WINDOW = timedelta(hours=72)
_RECEIVED = datetime(2026, 8, 26, 12, 0, tzinfo=UTC)
_LATENESS = Evidence.Lateness

_open_statuses = st.sampled_from(
    [
        None,
        Milestone.Status.PENDING,
        Milestone.Status.IN_PROGRESS,
        Milestone.Status.SUSPENDED,
        Milestone.Status.UNDER_ACCEPTANCE,
    ]
)
_closed_statuses = st.sampled_from(
    [Milestone.Status.ACCEPTED, Milestone.Status.PAID, Milestone.Status.DISPUTED]
)
# Целые секунды вместо st.timedeltas: под xdist-нагрузкой генерация
# timedelta с микросекундами упирается в health check «too slow».
_delays = st.integers(min_value=0, max_value=400 * 24 * 3600).map(
    lambda seconds: timedelta(seconds=seconds)
)
_SETTINGS = {"suppress_health_check": [HealthCheck.too_slow], "deadline": None}


@settings(max_examples=200, **_SETTINGS)
@given(delay=_delays, status=_open_statuses)
def test_within_window_is_on_time_else_late(delay, status):
    lateness = services.compute_lateness(
        captured_at_device=_RECEIVED - delay,
        received_at=_RECEIVED,
        milestone_status=status,
        window=_WINDOW,
    )
    assert lateness == (_LATENESS.ON_TIME if delay <= _WINDOW else _LATENESS.LATE)


@settings(max_examples=100, **_SETTINGS)
@given(delay=_delays, status=_closed_statuses)
def test_after_acceptance_wins_regardless_of_capture_time(delay, status):
    assert (
        services.compute_lateness(
            captured_at_device=_RECEIVED - delay,
            received_at=_RECEIVED,
            milestone_status=status,
            window=_WINDOW,
        )
        == _LATENESS.AFTER_ACCEPTANCE
    )


@settings(max_examples=50, **_SETTINGS)
@given(status=_open_statuses)
def test_without_capture_time_is_unknown_not_on_time(status):
    """Веб-загрузка без манифеста: «в окне» утверждать нечем (ADR-136 п.5)."""
    assert (
        services.compute_lateness(
            captured_at_device=None, received_at=_RECEIVED, milestone_status=status, window=_WINDOW
        )
        == _LATENESS.UNKNOWN
    )


def test_web_upload_to_accepted_milestone_is_after_acceptance_even_without_capture_time():
    assert (
        services.compute_lateness(
            captured_at_device=None,
            received_at=_RECEIVED,
            milestone_status=Milestone.Status.ACCEPTED,
            window=None,
        )
        == _LATENESS.AFTER_ACCEPTANCE
    )


def test_missing_window_config_is_an_error_when_capture_time_known():
    from apps.deadlines.services import DeadlineKindNotConfiguredError

    with pytest.raises(DeadlineKindNotConfiguredError):
        services.compute_lateness(
            captured_at_device=_RECEIVED - timedelta(hours=1),
            received_at=_RECEIVED,
            milestone_status=None,
            window=None,
        )
