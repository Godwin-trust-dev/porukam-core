from __future__ import annotations

import pytest

from common import tasks
from common.models import TaskHeartbeat

pytestmark = pytest.mark.django_db


def test_relay_sweep_records_heartbeat_even_without_pending_events():
    tasks.relay_sweep()

    assert TaskHeartbeat.objects.filter(name="outbox_relay").exists()
