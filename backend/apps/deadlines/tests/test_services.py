from datetime import timedelta
from uuid import uuid4

import pytest
from django.utils import timezone

from apps.deadlines import selectors, services, tasks
from apps.deadlines.models import DeadlineKindConfig, DomainDeadline
from common.models import OutboxEvent

pytestmark = pytest.mark.django_db


@pytest.fixture
def kind_config() -> DeadlineKindConfig:
    return DeadlineKindConfig.objects.create(kind="test_kind", duration=timedelta(hours=48))


def _subject() -> dict:
    return {"subject_type": "milestone", "subject_id": uuid4()}


def test_create_deadline_without_anchor_does_not_tick(kind_config):
    """fundament.md ЭФ.2: «дедлайн без якоря не тикает»."""
    deadline = services.create_deadline(
        kind=kind_config.kind,
        starts_from=DomainDeadline.StartsFrom.CABINET_PLACEMENT,
        **_subject(),
    )
    assert deadline.anchor_at is None
    assert deadline.deadline_at is None


def test_create_deadline_with_anchor_computes_deadline_at(kind_config):
    now = timezone.now()
    deadline = services.create_deadline(
        kind=kind_config.kind,
        starts_from=DomainDeadline.StartsFrom.EVENT,
        anchor_at=now,
        **_subject(),
    )
    assert deadline.anchor_at == now
    assert deadline.deadline_at == now + kind_config.duration


def test_create_deadline_unknown_kind_raises_when_anchored():
    with pytest.raises(services.DeadlineKindNotConfiguredError):
        services.create_deadline(
            kind="no_such_kind",
            starts_from=DomainDeadline.StartsFrom.EVENT,
            anchor_at=timezone.now(),
            **_subject(),
        )


def test_anchor_deadline_sets_deadline_at(kind_config):
    deadline = services.create_deadline(
        kind=kind_config.kind, starts_from=DomainDeadline.StartsFrom.CABINET_PLACEMENT, **_subject()
    )
    now = timezone.now()
    anchored = services.anchor_deadline(deadline, at=now)
    assert anchored.anchor_at == now
    assert anchored.deadline_at == now + kind_config.duration


def test_anchor_deadline_twice_raises(kind_config):
    deadline = services.create_deadline(
        kind=kind_config.kind,
        starts_from=DomainDeadline.StartsFrom.EVENT,
        anchor_at=timezone.now(),
        **_subject(),
    )
    with pytest.raises(services.DeadlineAlreadyAnchoredError):
        services.anchor_deadline(deadline, at=timezone.now())


def test_pause_stops_it_from_being_active(kind_config):
    deadline = services.create_deadline(
        kind=kind_config.kind,
        starts_from=DomainDeadline.StartsFrom.EVENT,
        anchor_at=timezone.now() - timedelta(days=10),
        **_subject(),
    )
    paused = services.pause_deadline(deadline, reason="ожидание материалов")
    assert paused.paused is True
    assert paused.pause_reason == "ожидание материалов"


def test_resume_clears_pause():
    deadline = DomainDeadline.objects.create(
        kind="test_kind",
        subject_type="milestone",
        subject_id=uuid4(),
        starts_from=DomainDeadline.StartsFrom.EVENT,
        paused=True,
        pause_reason="ожидание материалов",
    )
    resumed = services.resume_deadline(deadline)
    assert resumed.paused is False
    assert resumed.pause_reason is None


def test_compensate_downtime_shifts_all_active_and_skips_fired(kind_config):
    now = timezone.now()
    active = services.create_deadline(
        kind=kind_config.kind,
        starts_from=DomainDeadline.StartsFrom.EVENT,
        anchor_at=now,
        **_subject(),
    )
    paused_active = services.create_deadline(
        kind=kind_config.kind,
        starts_from=DomainDeadline.StartsFrom.EVENT,
        anchor_at=now,
        **_subject(),
    )
    services.pause_deadline(paused_active, reason="простой")
    unanchored = services.create_deadline(
        kind=kind_config.kind,
        starts_from=DomainDeadline.StartsFrom.CABINET_PLACEMENT,
        **_subject(),
    )
    fired = services.create_deadline(
        kind=kind_config.kind,
        starts_from=DomainDeadline.StartsFrom.EVENT,
        anchor_at=now,
        **_subject(),
    )
    fired.fired_at = now
    fired.outcome = "timed_out"
    fired.save(update_fields=["fired_at", "outcome"])
    fired_deadline_at_before = fired.deadline_at

    downtime = timedelta(minutes=17)
    touched = services.compensate_downtime(downtime)

    active.refresh_from_db()
    paused_active.refresh_from_db()
    unanchored.refresh_from_db()
    fired.refresh_from_db()

    assert touched == 2  # active + paused_active (заякорены, не сработали)
    assert active.deadline_at == now + kind_config.duration + downtime
    assert paused_active.deadline_at == now + kind_config.duration + downtime
    assert unanchored.deadline_at is None
    assert fired.deadline_at == fired_deadline_at_before  # сработавшие не трогаем


# --- ADR-138: перенос и досрочное закрытие --------------------------------


def test_reschedule_deadline_moves_anchor_and_recomputes_deadline_at(kind_config):
    first = timezone.now() - timedelta(days=1)
    deadline = services.create_deadline(
        kind=kind_config.kind,
        starts_from=DomainDeadline.StartsFrom.EVENT,
        anchor_at=first,
        **_subject(),
    )
    later = timezone.now()
    services.reschedule_deadline(deadline, anchor_at=later)
    deadline.refresh_from_db()
    assert deadline.anchor_at == later
    assert deadline.deadline_at == later + kind_config.duration
    assert DomainDeadline.objects.filter(subject_id=deadline.subject_id).count() == 1


def test_reschedule_fired_deadline_is_forbidden(kind_config):
    deadline = services.create_deadline(
        kind=kind_config.kind,
        starts_from=DomainDeadline.StartsFrom.EVENT,
        anchor_at=timezone.now(),
        **_subject(),
    )
    deadline.fired_at = timezone.now()
    deadline.save(update_fields=["fired_at"])
    with pytest.raises(services.DeadlineAlreadyFiredError):
        services.reschedule_deadline(deadline, anchor_at=timezone.now())


def test_close_deadline_sets_outcome_without_firing_event(kind_config):
    from common.models import OutboxEvent

    deadline = services.create_deadline(
        kind=kind_config.kind,
        starts_from=DomainDeadline.StartsFrom.EVENT,
        anchor_at=timezone.now(),
        **_subject(),
    )
    services.close_deadline(deadline, outcome="execution_finished")
    deadline.refresh_from_db()
    assert deadline.fired_at is not None
    assert deadline.outcome == "execution_finished"
    assert not OutboxEvent.objects.filter(topic="domain_deadline.fired").exists()


def test_close_deadline_twice_is_forbidden(kind_config):
    deadline = services.create_deadline(
        kind=kind_config.kind,
        starts_from=DomainDeadline.StartsFrom.EVENT,
        anchor_at=timezone.now(),
        **_subject(),
    )
    services.close_deadline(deadline, outcome="x")
    with pytest.raises(services.DeadlineAlreadyFiredError):
        services.close_deadline(deadline, outcome="y")


# --- close_deadline: досрочное закрытие доменной причиной --------------------


def test_close_deadline_sets_fired_at_and_outcome_without_event(kind_config):
    subject = _subject()
    deadline = services.create_deadline(
        kind=kind_config.kind,
        starts_from=DomainDeadline.StartsFrom.EVENT,
        anchor_at=timezone.now(),
        **subject,
    )
    before = OutboxEvent.objects.filter(topic="domain_deadline.fired").count()

    closed = services.close_deadline(deadline, outcome="accepted")

    assert closed.fired_at is not None
    assert closed.outcome == "accepted"
    # Срабатывания не было — событие `domain_deadline.fired` не публикуется.
    assert OutboxEvent.objects.filter(topic="domain_deadline.fired").count() == before
    # Для читающих сторон дедлайн больше не активен.
    assert not selectors.list_active_for_subject(**subject).exists()


def test_close_deadline_is_skipped_by_sweep_even_when_overdue(kind_config):
    deadline = services.create_deadline(
        kind=kind_config.kind,
        starts_from=DomainDeadline.StartsFrom.EVENT,
        anchor_at=timezone.now() - timedelta(days=10),
        **_subject(),
    )
    services.close_deadline(deadline, outcome="accepted")

    assert tasks.sweep_domain_deadlines() == 0
    deadline.refresh_from_db()
    assert deadline.outcome == "accepted"  # свип не перезаписал исход


def test_close_deadline_twice_raises(kind_config):
    deadline = services.create_deadline(
        kind=kind_config.kind,
        starts_from=DomainDeadline.StartsFrom.EVENT,
        anchor_at=timezone.now(),
        **_subject(),
    )
    services.close_deadline(deadline, outcome="accepted")
    with pytest.raises(services.DeadlineAlreadyFiredError):
        services.close_deadline(deadline, outcome="rejected")


def test_close_unanchored_deadline_is_allowed(kind_config):
    """Незаякоренный дедлайн (deadline_at IS NULL) тоже закрывается —
    активным ему оставаться не за чем."""
    deadline = services.create_deadline(
        kind=kind_config.kind,
        starts_from=DomainDeadline.StartsFrom.CABINET_PLACEMENT,
        **_subject(),
    )
    closed = services.close_deadline(deadline, outcome="rejected")
    assert closed.fired_at is not None
    assert closed.deadline_at is None


# --- ADR-140: длительность конкретного дедлайна из условий договора ----------


@pytest.fixture
def adr140_kind():
    DeadlineKindConfig.objects.update_or_create(
        kind="adr140_kind", defaults={"duration": timedelta(hours=48)}
    )


def test_create_deadline_with_duration_override_anchors_by_override(adr140_kind):
    deadline = services.create_deadline(
        kind="adr140_kind",
        subject_type="milestone",
        subject_id=uuid4(),
        starts_from="cabinet_placement",
        duration=timedelta(hours=72),
    )
    assert deadline.duration_override == timedelta(hours=72)
    assert deadline.deadline_at is None  # не заякорен — не тикает
    at = timezone.now()
    services.anchor_deadline(deadline, at=at)
    assert deadline.deadline_at == at + timedelta(hours=72)
    # перенос сохраняет своё окно, а не откатывается к категории
    later = at + timedelta(hours=5)
    services.reschedule_deadline(deadline, anchor_at=later)
    assert deadline.deadline_at == later + timedelta(hours=72)


def test_create_deadline_without_override_uses_kind_duration(adr140_kind):
    at = timezone.now()
    deadline = services.create_deadline(
        kind="adr140_kind",
        subject_type="milestone",
        subject_id=uuid4(),
        starts_from="event",
        anchor_at=at,
    )
    assert deadline.duration_override is None
    assert deadline.deadline_at == at + timedelta(hours=48)


def test_create_deadline_override_must_be_positive(adr140_kind):
    with pytest.raises(ValueError):
        services.create_deadline(
            kind="adr140_kind",
            subject_type="milestone",
            subject_id=uuid4(),
            starts_from="cabinet_placement",
            duration=timedelta(0),
        )


def test_create_deadline_override_does_not_replace_kind_config():
    with pytest.raises(services.DeadlineKindNotConfiguredError):
        services.create_deadline(
            kind="adr140_missing",
            subject_type="milestone",
            subject_id=uuid4(),
            starts_from="event",
            anchor_at=timezone.now(),
            duration=timedelta(hours=1),
        )
