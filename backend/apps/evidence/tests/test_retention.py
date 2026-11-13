"""RetentionTimer (ADR-036/ADR-137, ADR-136 п.4): старт по окончанию сделки
(подписчик outbox), пауза/возобновление при споре с жёстким пределом 6 мес,
срабатывание по свипу дедлайнов (архив -> crypto-shredding), идемпотентность
повторной доставки, уведомление «скачайте себе» обеим сторонам."""

from __future__ import annotations

from datetime import timedelta

import pytest
from django.utils import timezone

from apps.deadlines import tasks as deadlines_tasks
from apps.deadlines.models import DomainDeadline
from apps.disputes.models import Dispute
from apps.evidence import handlers, selectors, services
from apps.evidence.models import Evidence, RetentionTimer
from apps.evidence.storage import FakeEvidenceObjectStore
from apps.milestones.tests._execution_helpers import make_signed_contract_with_leaf, make_user
from apps.notifications import subscriber as notifications_subscriber
from apps.notifications.models import Notification
from common import outbox
from common.models import OutboxEvent, SubjectKey

from ._fixtures import jpeg_with_gps_exif_and_thumbnail, jpeg_without_exif

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

_HOT = timedelta(days=90)
_ARCHIVE = timedelta(days=365)
_NOTICE = timedelta(days=10)
_CAP = timedelta(days=180)


@pytest.fixture
def customer():
    return make_user("rt001")


@pytest.fixture
def contractor():
    user = make_user("rt002")
    user.country_code = "RU"
    user.save(update_fields=["country_code"])
    return user


@pytest.fixture
def signed(customer, contractor):
    return make_signed_contract_with_leaf(customer=customer, contractor=contractor)


@pytest.fixture
def store():
    return FakeEvidenceObjectStore()


def _contract_event(topic: str, contract, **payload) -> OutboxEvent:
    return outbox.publish(
        topic,
        subject={"type": "contract", "id": str(contract.id)},
        payload={"contract_id": str(contract.id), **payload},
        actor={},
    )


def _dispute_event(topic: str, contract, dispute_id: str = "d-1") -> OutboxEvent:
    return outbox.publish(
        topic,
        subject={"type": "dispute", "id": dispute_id, "contract_id": str(contract.id)},
        payload={"contract_id": str(contract.id)},
        actor={},
    )


def _start(contract, *, anchored_at=None) -> RetentionTimer:
    anchored_at = anchored_at or timezone.now()
    handlers.handle_contract_ended(
        _contract_event("contract.completed", contract, occurred_at=anchored_at.isoformat())
    )
    return RetentionTimer.objects.get(contract=contract)


def _deadline(deadline_id) -> DomainDeadline:
    return DomainDeadline.objects.get(pk=deadline_id)


def _upload(contract, milestone, user, store, content=None):
    return services.upload_evidence(
        contract,
        user=user,
        content=content or jpeg_without_exif(),
        file_name="photo.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        object_store=store,
    )


def _fire(deadline_id) -> OutboxEvent:
    """Свип дедлайнов (apps.deadlines, строки БД + sweep) -> событие
    `domain_deadline.fired` -> наш подписчик."""
    DomainDeadline.objects.filter(pk=deadline_id).update(
        deadline_at=timezone.now() - timedelta(minutes=1)
    )
    assert deadlines_tasks.sweep_domain_deadlines() == 1
    event = OutboxEvent.objects.get(
        topic="domain_deadline.fired", payload__deadline_id=str(deadline_id)
    )
    handlers.handle_deadline_fired(event)
    return event


# --- старт --------------------------------------------------------------------


def test_contract_completed_starts_timer_with_three_deadlines(signed):
    contract, _ = signed
    anchored_at = timezone.now()
    timer = _start(contract, anchored_at=anchored_at)

    assert timer.state == RetentionTimer.State.HOT
    assert timer.anchored_at == anchored_at
    hot, archive, notice = (
        _deadline(timer.hot_deadline_id),
        _deadline(timer.archive_deadline_id),
        _deadline(timer.notice_deadline_id),
    )
    assert (hot.kind, archive.kind, notice.kind) == (
        "evidence_hot_retention",
        "evidence_archive_retention",
        "evidence_retention_notice",
    )
    assert hot.deadline_at == anchored_at + _HOT
    assert archive.deadline_at == anchored_at + _ARCHIVE
    assert notice.deadline_at == anchored_at + _ARCHIVE - _NOTICE
    assert all(d.subject_type == "contract" for d in (hot, archive, notice))
    assert OutboxEvent.objects.filter(topic="evidence.retention_started").count() == 1


@pytest.mark.parametrize(
    "topic", ["contract.terminated", "contract.closed", "contract.auto_closed"]
)
def test_terminated_closed_and_auto_closed_also_start_timer(signed, topic):
    contract, _ = signed
    handlers.handle_contract_ended(_contract_event(topic, contract))
    assert RetentionTimer.objects.filter(contract=contract).exists()


@pytest.mark.parametrize(
    "topic",
    ["contract.completed", "contract.terminated", "contract.closed", "contract.auto_closed"],
)
def test_contract_end_topics_are_wired_to_retention_subscriber(settings, topic):
    """Все «окончания сделки» подписаны на старт таймера в OUTBOX_SUBSCRIBERS —
    включая автозакрытие без движения (ADR-138): там `contract.closed` не
    публикуется, и без своей подписки доказательства хранились бы вечно."""
    assert "apps.evidence.handlers.handle_contract_ended" in settings.OUTBOX_SUBSCRIBERS[topic]


def test_auto_closed_anchors_on_payload_occurred_at(signed):
    """ADR-138: `contract.auto_closed` несёт `occurred_at` момента автозакрытия
    — якорь таймера берётся из него, как у `contract.completed`."""
    contract, _ = signed
    anchored_at = timezone.now() - timedelta(days=3)
    handlers.handle_contract_ended(
        _contract_event(
            "contract.auto_closed",
            contract,
            reason="idle",
            idle_days=90,
            occurred_at=anchored_at.isoformat(),
        )
    )
    timer = RetentionTimer.objects.get(contract=contract)
    assert abs(timer.anchored_at - anchored_at) < timedelta(seconds=1)


def test_start_is_idempotent_on_redelivery(signed):
    contract, _ = signed
    first = _start(contract)
    handlers.handle_contract_ended(_contract_event("contract.closed", contract))
    handlers.handle_contract_ended(_contract_event("contract.completed", contract))

    assert RetentionTimer.objects.filter(contract=contract).count() == 1
    assert RetentionTimer.objects.get(contract=contract).hot_deadline_id == first.hot_deadline_id
    assert (
        DomainDeadline.objects.filter(subject_id=contract.id, kind__startswith="evidence_").count()
        == 3
    )


def test_start_with_open_dispute_begins_paused(signed, customer):
    contract, _ = signed
    Dispute.objects.create(kind=Dispute.Kind.WARRANTY, contract=contract, opened_by=customer)

    timer = _start(contract)

    assert timer.paused_at is not None
    assert all(d.paused for d in DomainDeadline.objects.filter(subject_id=contract.id))


# --- пауза / возобновление ---------------------------------------------------


def test_dispute_opened_pauses_all_deadlines(signed):
    contract, _ = signed
    timer = _start(contract)

    handlers.handle_dispute_opened(_dispute_event("dispute.opened", contract))

    timer.refresh_from_db()
    assert timer.paused_at is not None
    assert timer.pause_reason == "dispute:d-1"
    for deadline_id in (timer.hot_deadline_id, timer.archive_deadline_id, timer.notice_deadline_id):
        assert _deadline(deadline_id).paused is True


def test_pause_is_idempotent(signed):
    contract, _ = signed
    timer = _start(contract)
    handlers.handle_dispute_opened(_dispute_event("dispute.opened", contract))
    timer.refresh_from_db()
    first_paused_at = timer.paused_at

    handlers.handle_dispute_opened(_dispute_event("dispute.opened", contract, "d-2"))

    timer.refresh_from_db()
    assert timer.paused_at == first_paused_at


def test_dispute_resolved_resumes_and_extends_by_pause_duration(signed):
    """Спор на одиннадцатом месяце, пауза 5 дней: остаток меньше предела —
    срок продлевается ровно на длительность паузы."""
    contract, _ = signed
    anchored_at = timezone.now() - timedelta(days=300)
    timer = _start(contract, anchored_at=anchored_at)
    handlers.handle_dispute_opened(_dispute_event("dispute.opened", contract))
    paused_for = timedelta(days=5)
    RetentionTimer.objects.filter(pk=timer.pk).update(paused_at=timezone.now() - paused_for)

    handlers.handle_dispute_resolved(_dispute_event("dispute.resolved", contract))

    timer.refresh_from_db()
    assert timer.paused_at is None
    assert timer.paused_total >= paused_for
    hot, archive, notice = (
        _deadline(timer.hot_deadline_id),
        _deadline(timer.archive_deadline_id),
        _deadline(timer.notice_deadline_id),
    )
    assert not hot.paused and not archive.paused and not notice.paused
    tolerance = timedelta(seconds=5)
    assert abs(hot.deadline_at - (anchored_at + _HOT + paused_for)) < tolerance
    assert abs(archive.deadline_at - (anchored_at + _ARCHIVE + paused_for)) < tolerance
    assert notice.deadline_at == archive.deadline_at - _NOTICE


def test_resume_waits_for_last_open_dispute(signed, customer):
    contract, _ = signed
    timer = _start(contract)
    handlers.handle_dispute_opened(_dispute_event("dispute.opened", contract))
    Dispute.objects.create(kind=Dispute.Kind.WARRANTY, contract=contract, opened_by=customer)

    handlers.handle_dispute_resolved(_dispute_event("dispute.resolved", contract))

    timer.refresh_from_db()
    assert timer.paused_at is not None  # второй спор ещё открыт — пауза держится


def test_resume_without_pause_is_noop(signed):
    contract, _ = signed
    timer = _start(contract)
    before = _deadline(timer.archive_deadline_id).deadline_at
    handlers.handle_dispute_resolved(_dispute_event("dispute.resolved", contract))
    assert _deadline(timer.archive_deadline_id).deadline_at == before


def test_pause_extension_is_capped_six_months_after_dispute(signed):
    """ADR-137 требование 4: продление не дальше 6 мес после завершения
    спора — проверка в коде, не соглашение. Пауза 300 дней дала бы
    `anchored + 365 + 300`; предел режет до `now + 180`."""
    contract, _ = signed
    anchored_at = timezone.now() - timedelta(days=300)
    timer = _start(contract, anchored_at=anchored_at)
    handlers.handle_dispute_opened(_dispute_event("dispute.opened", contract))
    RetentionTimer.objects.filter(pk=timer.pk).update(
        paused_at=timezone.now() - timedelta(days=300)
    )

    handlers.handle_dispute_resolved(_dispute_event("dispute.resolved", contract))

    now = timezone.now()
    tolerance = timedelta(seconds=5)
    hot = _deadline(timer.hot_deadline_id)
    archive = _deadline(timer.archive_deadline_id)
    assert abs(archive.deadline_at - (now + _CAP)) < tolerance
    # горячий срок: base now-210d, с паузой now+90d — предел не достигнут
    assert abs(hot.deadline_at - (anchored_at + _HOT + timedelta(days=300))) < tolerance
    assert _deadline(timer.notice_deadline_id).deadline_at == archive.deadline_at - _NOTICE


def test_cap_never_shortens_base_promise(signed):
    """Спор на третьем месяце, пауза 2 месяца: остаток (9 мес) уже больше
    предела — продления нет, но и базовый `anchored + 1 год` оферты не
    срезается."""
    contract, _ = signed
    anchored_at = timezone.now() - timedelta(days=90)
    timer = _start(contract, anchored_at=anchored_at)
    handlers.handle_dispute_opened(_dispute_event("dispute.opened", contract))
    RetentionTimer.objects.filter(pk=timer.pk).update(paused_at=timezone.now() - timedelta(days=60))

    handlers.handle_dispute_resolved(_dispute_event("dispute.resolved", contract))

    archive = _deadline(timer.archive_deadline_id)
    assert archive.deadline_at == anchored_at + _ARCHIVE
    assert not archive.paused


# --- срабатывание по свипу ---------------------------------------------------


def test_hot_deadline_archives_evidence_rows(signed, customer, contractor, store):
    contract, milestone = signed
    ru = _upload(contract, milestone, contractor, store)
    glob = _upload(contract, milestone, customer, store)
    timer = _start(contract)

    _fire(timer.hot_deadline_id)

    timer.refresh_from_db()
    ru.refresh_from_db()
    glob.refresh_from_db()
    assert timer.state == RetentionTimer.State.ARCHIVED
    assert ru.retention_state == glob.retention_state == Evidence.RetentionState.ARCHIVED
    assert ru.archived_at is not None
    assert ru.s3_object_key  # архив — только состояние, оригинал на месте
    assert services.download_original(ru, user=customer, object_store=store)
    event = OutboxEvent.objects.get(topic="evidence.archived")
    assert event.payload["evidence_count"] == 2


def test_hot_deadline_handler_is_idempotent(signed, contractor, store):
    contract, milestone = signed
    _upload(contract, milestone, contractor, store)
    timer = _start(contract)
    event = _fire(timer.hot_deadline_id)

    handlers.handle_deadline_fired(event)  # повторная доставка (ADR-064)

    assert OutboxEvent.objects.filter(topic="evidence.archived").count() == 1


def test_notice_deadline_notifies_both_parties(signed, customer, contractor):
    contract, _ = signed
    timer = _start(contract)

    _fire(timer.notice_deadline_id)

    event = OutboxEvent.objects.get(topic="evidence.retention_expiring")
    assert event.payload["notice_days"] == 10
    assert (
        event.payload["expires_at"] == _deadline(timer.archive_deadline_id).deadline_at.isoformat()
    )
    notifications_subscriber.handle_event(event)
    placed = Notification.objects.filter(template="evidence.retention_expiring")
    assert {n.recipient_id for n in placed} == {customer.id, contractor.id}
    assert all(n.legal_significance for n in placed)


def test_archive_deadline_shreds_originals_keeps_hash_and_thumbnail(
    signed, customer, contractor, store
):
    contract, milestone = signed
    ru = _upload(contract, milestone, contractor, store, jpeg_with_gps_exif_and_thumbnail())
    glob = _upload(contract, milestone, customer, store)
    timer = _start(contract)
    key_ref = ru.encryption_key_ref
    ciphertext_key = ru.s3_object_key

    _fire(timer.archive_deadline_id)

    timer.refresh_from_db()
    ru.refresh_from_db()
    glob.refresh_from_db()
    assert timer.state == RetentionTimer.State.SHREDDED
    assert timer.archived_at is not None and timer.shredded_at is not None
    for row in (ru, glob):
        assert row.retention_state == Evidence.RetentionState.SHREDDED
        assert row.s3_object_key == "" and row.transit_payload is None
        assert row.file_hash and row.shredded_at is not None
    assert ru.thumbnail == b"\xff\xd8\xff\xd9"
    assert ru.encryption_key_ref == key_ref  # ссылка остаётся как след уничтожения
    assert SubjectKey.objects.get(id=key_ref).destroyed_at is not None
    assert ciphertext_key in store.objects  # объект в WORM не удаляется — он нечитаем
    with pytest.raises(services.EvidenceOriginalShreddedError):
        services.download_original(ru, user=customer, object_store=store)
    # «хеши бессрочно»: сверка предъявленной копии работает и после
    assert services.verify_hash(ru, presented_content=jpeg_without_exif(), user=customer) is False
    event = OutboxEvent.objects.get(topic="evidence.shredded")
    assert set(event.payload["evidence_ids"]) == {str(ru.id), str(glob.id)}
    # аудит: событие ушло в outbox (Audit Vault подписан на все топики)
    assert event.payload["evidence_count"] == 2


def test_archive_deadline_handler_is_idempotent(signed, contractor, store):
    contract, milestone = signed
    _upload(contract, milestone, contractor, store)
    timer = _start(contract)
    event = _fire(timer.archive_deadline_id)

    handlers.handle_deadline_fired(event)

    assert OutboxEvent.objects.filter(topic="evidence.shredded").count() == 1


def test_foreign_deadline_of_same_kind_is_ignored(signed):
    """Дедлайн той же категории, но не из таймера (id не сходится) — NOOP."""
    contract, _ = signed
    timer = _start(contract)
    event = outbox.publish(
        "domain_deadline.fired",
        subject={"type": "contract", "id": str(contract.id)},
        payload={
            "kind": "evidence_hot_retention",
            "deadline_id": "00000000-0000-0000-0000-000000000000",
        },
        actor={},
    )
    handlers.handle_deadline_fired(event)
    timer.refresh_from_db()
    assert timer.state == RetentionTimer.State.HOT


def test_paused_deadline_does_not_fire(signed):
    contract, _ = signed
    timer = _start(contract)
    handlers.handle_dispute_opened(_dispute_event("dispute.opened", contract))
    DomainDeadline.objects.filter(pk=timer.hot_deadline_id).update(
        deadline_at=timezone.now() - timedelta(minutes=1)
    )
    assert deadlines_tasks.sweep_domain_deadlines() == 0


# --- публичная политика ------------------------------------------------------


def test_retention_policy_from_config():
    assert selectors.retention_policy() == {
        "hot_days": 90,
        "archive_days": 365,
        "notice_days": 10,
        "dispute_pause_cap_days": 180,
        "hashes_forever": True,
    }
