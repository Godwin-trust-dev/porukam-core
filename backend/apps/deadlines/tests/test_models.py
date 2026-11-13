from uuid import uuid4

import pytest
from django.db import IntegrityError, transaction

from apps.deadlines.models import DomainDeadline

pytestmark = pytest.mark.django_db


def _deadline(**overrides):
    defaults = {
        "kind": "test_kind",
        "subject_type": "test_subject",
        "subject_id": uuid4(),
        "starts_from": DomainDeadline.StartsFrom.EVENT,
    }
    defaults.update(overrides)
    return DomainDeadline.objects.create(**defaults)


def test_defaults():
    deadline = _deadline()
    assert deadline.anchor_at is None
    assert deadline.deadline_at is None
    assert deadline.paused is False
    assert deadline.pause_reason is None
    assert deadline.fired_at is None
    assert deadline.outcome is None


def test_starts_from_check_constraint_rejects_invalid_value():
    """tech-spec.md §5.2.10: `starts_from text CHECK (in cabinet_placement|event)`
    — на живом PostgreSQL (CLAUDE.md), не только Django-choices."""
    with transaction.atomic(), pytest.raises(IntegrityError):
        DomainDeadline.objects.create(
            kind="test_kind",
            subject_type="test_subject",
            subject_id=uuid4(),
            starts_from="not_a_real_value",
        )
