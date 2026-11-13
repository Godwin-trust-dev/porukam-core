from __future__ import annotations

from datetime import timedelta
from unittest.mock import patch

import pytest
from django.utils import timezone

from common import circuit, heartbeat
from common.metrics import (
    CeleryQueueCollector,
    HeartbeatCollector,
    OutboxBacklogCollector,
    ProviderCircuitCollector,
)
from common.models import OutboxEvent

pytestmark = pytest.mark.django_db


def _samples(collector, metric_name):
    for family in collector.collect():
        if family.name == metric_name:
            return {tuple(sorted(s.labels.items())): s.value for s in family.samples}
    return {}


def test_outbox_backlog_collector_empty_queue_reports_zero():
    samples = _samples(OutboxBacklogCollector(), "porukam_outbox_unpublished_total")
    assert samples[()] == 0
    age_samples = _samples(
        OutboxBacklogCollector(), "porukam_outbox_oldest_unpublished_age_seconds"
    )
    assert age_samples[()] == 0.0


def test_outbox_backlog_collector_counts_unpublished_and_oldest_age():
    old = OutboxEvent.objects.create(topic="t", occurred_at=timezone.now(), payload={})
    OutboxEvent.objects.filter(pk=old.pk).update(created_at=timezone.now() - timedelta(seconds=120))
    OutboxEvent.objects.create(topic="t", occurred_at=timezone.now(), payload={})

    samples = _samples(OutboxBacklogCollector(), "porukam_outbox_unpublished_total")
    assert samples[()] == 2

    age_samples = _samples(
        OutboxBacklogCollector(), "porukam_outbox_oldest_unpublished_age_seconds"
    )
    assert age_samples[()] >= 120


def test_heartbeat_collector_reports_age_of_each_task():
    heartbeat.beat("deadlines_sweep")

    samples = _samples(HeartbeatCollector(), "porukam_task_heartbeat_age_seconds")
    assert samples[(("task", "deadlines_sweep"),)] < 5


def test_heartbeat_collector_empty_without_any_run():
    samples = _samples(HeartbeatCollector(), "porukam_task_heartbeat_age_seconds")
    assert samples == {}


def test_provider_circuit_collector_reflects_recorded_calls():
    circuit._reset_for_tests()
    circuit.record_success("sms_otp_fake")
    circuit.record_failure("sms_otp_fake")

    open_samples = _samples(ProviderCircuitCollector(), "porukam_provider_circuit_open")
    assert open_samples[(("provider", "sms_otp_fake"),)] == 0

    calls_samples = _samples(ProviderCircuitCollector(), "porukam_provider_calls_total")
    assert calls_samples[(("outcome", "success"), ("provider", "sms_otp_fake"))] == 1
    assert calls_samples[(("outcome", "failure"), ("provider", "sms_otp_fake"))] == 1


def test_celery_queue_collector_reports_llen_per_configured_queue():
    with patch("redis.Redis.from_url") as from_url:
        from_url.return_value.llen.return_value = 7
        samples = _samples(CeleryQueueCollector(), "porukam_celery_queue_length")

    assert samples[(("queue", "celery"),)] == 7


def test_celery_queue_collector_degrades_on_redis_error():
    import redis

    with patch("redis.Redis.from_url", side_effect=redis.RedisError("boom")):
        samples = _samples(CeleryQueueCollector(), "porukam_celery_queue_length")

    assert samples == {}
