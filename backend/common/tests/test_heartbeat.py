from __future__ import annotations

import pytest

from common import heartbeat
from common.models import TaskHeartbeat

pytestmark = pytest.mark.django_db


def test_beat_creates_row_on_first_call():
    heartbeat.beat("deadlines_sweep")

    row = TaskHeartbeat.objects.get(name="deadlines_sweep")
    assert row.last_run_at is not None


def test_beat_updates_existing_row_in_place():
    heartbeat.beat("deadlines_sweep")
    first = TaskHeartbeat.objects.get(name="deadlines_sweep").last_run_at

    heartbeat.beat("deadlines_sweep")
    second = TaskHeartbeat.objects.get(name="deadlines_sweep").last_run_at

    assert second >= first
    assert TaskHeartbeat.objects.count() == 1
