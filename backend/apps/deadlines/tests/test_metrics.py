from __future__ import annotations

from datetime import timedelta
from uuid import uuid4

import pytest
from django.utils import timezone

from apps.deadlines import services
from apps.deadlines.metrics import SweepLagCollector
from apps.deadlines.models import DeadlineKindConfig, DomainDeadline

pytestmark = pytest.mark.django_db


@pytest.fixture
def kind_config() -> DeadlineKindConfig:
    return DeadlineKindConfig.objects.create(kind="metrics_test", duration=timedelta(hours=1))


def _fired(kind_config, *, lag_seconds: float) -> DomainDeadline:
    deadline = services.create_deadline(
        kind=kind_config.kind,
        subject_type="milestone",
        subject_id=uuid4(),
        starts_from=DomainDeadline.StartsFrom.EVENT,
        anchor_at=timezone.now() - timedelta(hours=2),
    )
    deadline.fired_at = deadline.deadline_at + timedelta(seconds=lag_seconds)
    deadline.outcome = "timed_out"
    deadline.save(update_fields=["fired_at", "outcome"])
    return deadline


def _histogram_buckets(collector) -> dict[str, float]:
    for family in collector.collect():
        return {
            sample.labels["le"]: sample.value
            for sample in family.samples
            if sample.name.endswith("_bucket")
        }
    return {}


def test_empty_chain_reports_zero_everywhere():
    buckets = _histogram_buckets(SweepLagCollector())
    assert buckets["+Inf"] == 0


def test_fired_deadline_within_slo_counts_in_60s_bucket_and_above(kind_config):
    _fired(kind_config, lag_seconds=10)

    buckets = _histogram_buckets(SweepLagCollector())
    assert buckets["15.0"] == 1
    assert buckets["60.0"] == 1
    assert buckets["+Inf"] == 1


def test_fired_deadline_breaching_slo_only_counts_above_60s(kind_config):
    _fired(kind_config, lag_seconds=90)

    buckets = SweepLagCollector()
    values = _histogram_buckets(buckets)
    assert values["60.0"] == 0
    assert values["90.0"] == 1
    assert values["+Inf"] == 1


def test_ignores_deadlines_that_have_not_fired_yet(kind_config):
    services.create_deadline(
        kind=kind_config.kind,
        subject_type="milestone",
        subject_id=uuid4(),
        starts_from=DomainDeadline.StartsFrom.EVENT,
        anchor_at=timezone.now() - timedelta(hours=2),
    )

    buckets = _histogram_buckets(SweepLagCollector())
    assert buckets["+Inf"] == 0
