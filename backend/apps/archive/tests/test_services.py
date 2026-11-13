"""Автоэкспорт при завершении (ADR-137 треб. 1), юрзначимое письмо
независимо от настройки e-mail, порог вложения 20 МБ, нет адреса — ЛК +
no_email, shred файлов по evidence.shredded (пакет остаётся), отзыв,
идемпотентность постановки."""

from __future__ import annotations

import pytest
from django.test import override_settings
from django.utils import timezone

from apps.archive import handlers, selectors, services
from apps.archive.models import ArchiveExport, ArchiveLink
from apps.archive.storage import FakeArchiveObjectStore
from apps.notifications import services as notifications_services
from apps.notifications.models import DeliveryAttempt, Notification
from common import outbox
from common.models import OutboxEvent

from ._helpers import RecordingEmailProvider, checkpoint, make_deal, relay_all, upload

pytestmark = pytest.mark.django_db(databases=["default", "audit"])


def _contract_event(topic: str, contract, **payload) -> OutboxEvent:
    return outbox.publish(
        topic,
        subject={"type": "contract", "id": str(contract.id)},
        payload={"contract_id": str(contract.id), **payload},
        actor={},
    )


def _built(contract, contractor, store, *, provider=None, **options):
    export = services.request_export(contract, user=contractor, **options)
    archive_store = FakeArchiveObjectStore()
    services.build_export(
        export,
        evidence_store=store,
        archive_store=archive_store,
        email_provider=provider or RecordingEmailProvider(),
    )
    export.refresh_from_db()
    return export, archive_store


def test_request_export_is_idempotent_while_running_and_rejects_conflicting_options():
    contract, _ms, _c, contractor, _store = make_deal("s1")
    first = services.request_export(contract, user=contractor)
    second = services.request_export(contract, user=contractor)
    assert first.id == second.id
    assert first.status == "queued"
    assert first.is_snapshot is True
    with pytest.raises(services.ExportOptionsConflictError):
        services.request_export(
            contract, user=contractor, include_originals=True, manifest_only=True
        )
    assert OutboxEvent.objects.filter(topic="archive.export_requested").count() == 1


def test_contract_completed_auto_exports_for_both_parties(django_capture_on_commit_callbacks):
    contract, milestone, customer, contractor, store = make_deal("s2")
    upload(contract, milestone, contractor, store)
    relay_all()
    checkpoint()
    # e-mail у обоих ВЫКЛЮЧЕН (дефолт новых пользователей, 0015) — письмо
    # всё равно уходит: юрзначимое (ADR-139 решение владельца).
    for user in (customer, contractor):
        assert notifications_services.get_or_create_settings(user).email_enabled is False
    contract.execution_status = "completed"
    contract.save(update_fields=["execution_status"])

    with override_settings(EVIDENCE_OBJECT_STORE="fake", ARCHIVE_OBJECT_STORE="fake"):
        from apps.evidence import storage as evidence_storage

        evidence_storage._fake_store.objects.update(store.objects)
        with django_capture_on_commit_callbacks(execute=True):
            handlers.handle_contract_ended(
                _contract_event(
                    "contract.completed", contract, completed_at=timezone.now().isoformat()
                )
            )
        # Повторная доставка — второй автоэкспорт не заводится.
        with django_capture_on_commit_callbacks(execute=True):
            handlers.handle_contract_ended(_contract_event("contract.auto_closed", contract))

    exports = list(ArchiveExport.objects.filter(contract=contract))
    assert len(exports) == 1
    export = exports[0]
    assert export.trigger == "auto"
    assert export.status == "ready", export.error
    assert export.is_snapshot is False
    assert ArchiveLink.objects.filter(export=export).count() == 4
    notifications = Notification.objects.filter(template="archive.ready")
    assert {n.recipient_id for n in notifications} == {customer.id, contractor.id}
    for notification in notifications:
        assert notification.legal_significance is True
        assert notification.placed_in_cabinet_at is not None
        assert notification.payload["package_url"].startswith("http://localhost:5173/a/")
        assert notification.payload["files_url"]
        email = DeliveryAttempt.objects.get(notification=notification, channel="email")
        assert email.status == "sent"


def test_email_without_address_is_recorded_as_no_email():
    contract, milestone, customer, contractor, store = make_deal("s3")
    customer.email = ""
    customer.save(update_fields=["email"])
    upload(contract, milestone, contractor, store)
    relay_all()
    provider = RecordingEmailProvider()
    _built(contract, contractor, store, provider=provider)
    assert [u.id for u, _ in provider.messages] == [contractor.id]
    notification = Notification.objects.get(template="archive.ready", recipient=customer)
    email = DeliveryAttempt.objects.get(notification=notification, channel="email")
    assert email.status == "no_email"
    assert DeliveryAttempt.objects.get(notification=notification, channel="in_app").status == (
        "placed_in_cabinet"
    )


@override_settings(ARCHIVE_EMAIL_ATTACHMENT_MAX_BYTES=16)
def test_package_over_attachment_limit_goes_without_attachment():
    contract, milestone, _c, contractor, store = make_deal("s4")
    upload(contract, milestone, contractor, store)
    relay_all()
    provider = RecordingEmailProvider()
    export, _ = _built(contract, contractor, store, provider=provider)
    assert export.package_size > 16
    for _user, message in provider.messages:
        assert "attachments" not in message
        assert message["payload"]["package_attached"] is False
        assert message["payload"]["package_url"]


def test_evidence_shredded_removes_files_zip_but_keeps_package():
    contract, milestone, _c, contractor, store = make_deal("s5")
    upload(contract, milestone, contractor, store)
    relay_all()
    export, archive_store = _built(contract, contractor, store)
    assert export.files_key in archive_store.objects

    services.shred_export_files(contract.id, archive_store=archive_store)
    services.shred_export_files(contract.id, archive_store=archive_store)  # идемпотентно
    export.refresh_from_db()
    assert export.files_state == "shredded"
    assert export.files_key == ""
    assert export.files_shredded_at is not None
    assert export.files_sha256  # хеш файлов остаётся
    assert export.package_key in archive_store.objects
    assert services.read_artifact(export, kind="package", archive_store=archive_store).startswith(
        b"PK"
    )
    with pytest.raises(services.ArchiveFilesShreddedError):
        services.read_artifact(export, kind="files", archive_store=archive_store)
    assert OutboxEvent.objects.filter(topic="archive.files_shredded").count() == 1
    # Подписчик на evidence.shredded ведёт туда же.
    handlers.handle_evidence_shredded(
        outbox.publish(
            "evidence.shredded",
            subject={"type": "contract", "id": str(contract.id)},
            payload={"contract_id": str(contract.id)},
            actor={},
        )
    )


def test_revoke_link_requires_party_and_destroys_token():
    contract, milestone, customer, contractor, store = make_deal("s6")
    upload(contract, milestone, contractor, store)
    relay_all()
    export, _ = _built(contract, contractor, store)
    link = export.links.get(kind="package", party_role="customer")
    token = services.link_token_for_party(link)
    assert token and len(token) >= 32
    assert services.resolve_link(token).id == link.id

    from apps.contracts import services as contracts_services
    from apps.milestones.tests._execution_helpers import make_user

    stranger = make_user("a99s6")
    with pytest.raises(contracts_services.NotAPartyError):
        services.revoke_link(link, user=stranger)
    # Любая сторона (здесь — контрагент владельца ссылки) может отозвать.
    services.revoke_link(link, user=contractor)
    link.refresh_from_db()
    assert link.revoked_at is not None
    assert services.link_token_for_party(link) is None
    with pytest.raises(services.ArchiveLinkRevokedError):
        services.resolve_link(token)
    assert OutboxEvent.objects.filter(topic="archive.link_revoked").count() == 1


def test_nothing_to_export_for_never_frozen_draft():
    from apps.milestones.tests._execution_helpers import make_under_review_contract, make_user

    customer, contractor = make_user("a71"), make_user("a72")
    draft = make_under_review_contract(customer=customer, contractor=contractor)
    assert selectors.can_export(draft) is False
    with pytest.raises(services.NothingToExportError):
        services.request_export(draft, user=customer)
    assert services.request_auto_export(draft) is None
