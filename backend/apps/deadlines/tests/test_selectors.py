from uuid import uuid4

import pytest
from django.http import Http404
from django.utils import timezone

from apps.deadlines import selectors
from apps.deadlines.models import DomainDeadline

pytestmark = pytest.mark.django_db


def _deadline(**overrides):
    defaults = {
        "kind": "test_kind",
        "subject_type": "milestone",
        "subject_id": uuid4(),
        "starts_from": DomainDeadline.StartsFrom.EVENT,
    }
    defaults.update(overrides)
    return DomainDeadline.objects.create(**defaults)


def test_get_deadline_or_404_found():
    deadline = _deadline()
    assert selectors.get_deadline_or_404(deadline.id).id == deadline.id


def test_get_deadline_or_404_missing_raises():
    with pytest.raises(Http404):
        selectors.get_deadline_or_404(uuid4())


def test_list_active_for_subject_excludes_fired():
    subject_id = uuid4()
    active = _deadline(subject_type="milestone", subject_id=subject_id)
    fired = _deadline(subject_type="milestone", subject_id=subject_id)
    fired.fired_at = timezone.now()
    fired.outcome = "timed_out"
    fired.save(update_fields=["fired_at", "outcome"])

    result_ids = set(
        selectors.list_active_for_subject(
            subject_type="milestone", subject_id=subject_id
        ).values_list("id", flat=True)
    )
    assert result_ids == {active.id}
