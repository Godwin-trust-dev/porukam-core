"""fundament.md ЭФ.2: property-тест (Hypothesis) — после ЛЮБОЙ последовательности
пауз/резюме/компенсаций простоя относительный порядок дедлайнов по deadline_at
сохраняется (compensate_downtime сдвигает ВСЕ активные на одинаковую величину,
pause/resume deadline_at не меняют — монотонный общий сдвиг не может поменять
порядок)."""

from __future__ import annotations

from datetime import timedelta
from uuid import uuid4

import pytest
from django.utils import timezone
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from apps.deadlines import services
from apps.deadlines.models import DeadlineKindConfig, DomainDeadline

pytestmark = pytest.mark.django_db

_KIND = "hypothesis_kind"

_OFFSETS = st.lists(
    st.integers(min_value=0, max_value=1_000_000), min_size=2, max_size=5, unique=True
)
_OPS = st.lists(
    st.tuples(
        st.integers(min_value=0, max_value=4),
        st.sampled_from(["pause", "resume", "compensate"]),
        st.integers(min_value=1, max_value=10_000),
    ),
    min_size=0,
    max_size=10,
)


@given(offsets=_OFFSETS, ops=_OPS)
@settings(
    max_examples=25,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture],
)
def test_order_preserved_after_any_pause_resume_compensate_sequence(offsets, ops):
    DeadlineKindConfig.objects.get_or_create(kind=_KIND, defaults={"duration": timedelta(hours=1)})
    base = timezone.now()

    deadlines = [
        services.create_deadline(
            kind=_KIND,
            subject_type="test",
            subject_id=uuid4(),
            starts_from=DomainDeadline.StartsFrom.EVENT,
            anchor_at=base,
        )
        for _ in offsets
    ]
    for deadline, offset in zip(deadlines, offsets, strict=True):
        deadline.deadline_at = base + timedelta(seconds=offset)
        deadline.save(update_fields=["deadline_at"])

    ids = [d.id for d in deadlines]

    def order_by_deadline_at() -> list:
        return list(
            DomainDeadline.objects.filter(id__in=ids)
            .order_by("deadline_at")
            .values_list("id", flat=True)
        )

    order_before = order_by_deadline_at()

    for index, op, minutes in ops:
        target = deadlines[index % len(deadlines)]
        if op == "pause":
            services.pause_deadline(target, reason="hypothesis")
        elif op == "resume":
            services.resume_deadline(target)
        else:
            services.compensate_downtime(timedelta(minutes=minutes))

    order_after = order_by_deadline_at()
    assert order_before == order_after
