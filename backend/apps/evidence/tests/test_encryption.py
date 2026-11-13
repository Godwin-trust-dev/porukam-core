"""Шифрование оригиналов at rest (ADR-136 п.2): RU-объект в S3 —
шифротекст конверта `common.crypto`, download/backup расшифровывают,
`file_hash` — от открытых байт; backfill объектов до ADR-136 идемпотентен и
не трогает объект с несошедшимся хешем."""

from __future__ import annotations

from io import StringIO

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import override_settings

from apps.accounts.models import SocialLoginAccount
from apps.evidence import services
from apps.evidence.models import Evidence
from apps.evidence.providers import FakeGoogleDriveBackupProvider
from apps.evidence.storage import FakeEvidenceObjectStore, build_evidence_object_store
from apps.milestones.tests._execution_helpers import make_signed_contract_with_leaf, make_user
from common import crypto
from common.models import SubjectKey
from services.evidence_ingest import pipeline

from ._fixtures import jpeg_with_gps_exif_and_thumbnail, jpeg_without_exif

pytestmark = pytest.mark.django_db(databases=["default", "audit"])


@pytest.fixture
def customer():
    return make_user("en001")


@pytest.fixture
def contractor():
    user = make_user("en002")
    user.country_code = "RU"  # RU-контур -> storage_mode=ru (серверное хранение)
    user.save(update_fields=["country_code"])
    return user


@pytest.fixture
def signed(customer, contractor):
    return make_signed_contract_with_leaf(customer=customer, contractor=contractor)


@pytest.fixture
def store():
    return FakeEvidenceObjectStore()


def _upload_ru(contract, milestone, contractor, store, content=None):
    return services.upload_evidence(
        contract,
        user=contractor,
        content=content or jpeg_with_gps_exif_and_thumbnail(),
        file_name="photo.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        object_store=store,
    )


def test_ru_upload_stores_ciphertext_and_hash_of_plaintext(signed, contractor, store):
    contract, milestone = signed
    evidence = _upload_ru(contract, milestone, contractor, store)

    assert evidence.storage_mode == Evidence.StorageMode.SERVER
    assert evidence.encryption_key_ref
    stored = store.objects[evidence.s3_object_key]
    plaintext = crypto.decrypt_bytes_for_subject(stored, evidence.encryption_key_ref)
    assert stored != plaintext
    assert b"Exif" not in plaintext  # очищенные байты (ADR-045)
    assert pipeline.compute_sha256(plaintext) == evidence.file_hash
    assert pipeline.compute_sha256(stored) != evidence.file_hash  # хеш — не от шифротекста
    key = SubjectKey.objects.get(id=evidence.encryption_key_ref)
    assert (key.subject_type, key.subject_id) == ("evidence", str(evidence.id))


def test_global_user_also_stores_encrypted_original(signed, customer, store):
    """ADR-136 «Отмена части ГВ.3»: пользователь без страны (GLOBAL-контур)
    — оригинал ТОЖЕ в бакете, шифротекстом; transit_payload не используется."""
    contract, milestone = signed
    assert not customer.country_code
    evidence = _upload_ru(contract, milestone, customer, store)

    assert evidence.storage_mode == Evidence.StorageMode.SERVER
    assert evidence.transit_payload is None
    assert evidence.encryption_key_ref
    stored = store.objects[evidence.s3_object_key]
    assert pipeline.compute_sha256(stored) != evidence.file_hash
    assert (
        pipeline.compute_sha256(
            crypto.decrypt_bytes_for_subject(stored, evidence.encryption_key_ref)
        )
        == evidence.file_hash
    )


def test_download_decrypts_for_counterparty(signed, customer, contractor, store):
    contract, milestone = signed
    evidence = _upload_ru(contract, milestone, contractor, store)

    content = services.download_original(evidence, user=customer, object_store=store)

    assert pipeline.compute_sha256(content) == evidence.file_hash
    assert services.verify_hash(evidence, presented_content=content, user=customer)


def test_backup_uploads_plaintext_to_drive(signed, contractor, store):
    contract, milestone = signed
    evidence = _upload_ru(contract, milestone, contractor, store)
    SocialLoginAccount.objects.create(user=contractor, provider="google", sub="sub-en-1")

    class CapturingProvider(FakeGoogleDriveBackupProvider):
        sent: list[bytes] = []

        def upload(self, *, account_sub, file_name, content, mime_type):
            self.sent.append(content)
            return super().upload(
                account_sub=account_sub, file_name=file_name, content=content, mime_type=mime_type
            )

    provider = CapturingProvider()
    evidence = services.request_backup(
        evidence, user=contractor, provider=provider, object_store=store
    )

    assert evidence.backup_status == Evidence.BackupStatus.COMPLETED
    assert pipeline.compute_sha256(provider.sent[0]) == evidence.file_hash


def test_serializer_flags_encrypted_at_rest_and_no_strong_protection(signed, contractor, store):
    from apps.evidence.api.serializers import EvidenceSerializer

    contract, milestone = signed
    data = EvidenceSerializer(_upload_ru(contract, milestone, contractor, store)).data
    assert data["encrypted_at_rest"] is True
    assert data["strong_protection"] is False
    assert data["lateness"] == "unknown"
    assert data["retention_state"] == "hot"
    assert data["original_available"] is True
    assert "geo_encrypted" not in data and "geo" not in data


# --- backfill объектов до ADR-136 --------------------------------------------


def _legacy_plaintext_row(contract, milestone, contractor, store) -> Evidence:
    """Строка «как до ADR-136»: открытые байты в S3, key_ref пуст."""
    evidence = _upload_ru(contract, milestone, contractor, store, content=jpeg_without_exif())
    plaintext = crypto.decrypt_bytes_for_subject(
        store.objects[evidence.s3_object_key], evidence.encryption_key_ref
    )
    store.objects[evidence.s3_object_key] = plaintext
    Evidence.objects.filter(pk=evidence.pk).update(encryption_key_ref="")
    evidence.refresh_from_db()
    return evidence


def test_legacy_plaintext_is_readable_until_backfill(signed, customer, contractor, store):
    contract, milestone = signed
    evidence = _legacy_plaintext_row(contract, milestone, contractor, store)
    content = services.download_original(evidence, user=customer, object_store=store)
    assert pipeline.compute_sha256(content) == evidence.file_hash


def test_encrypt_legacy_original_writes_new_key_and_is_idempotent(
    signed, customer, contractor, store
):
    contract, milestone = signed
    evidence = _legacy_plaintext_row(contract, milestone, contractor, store)
    old_key = evidence.s3_object_key

    assert services.encrypt_legacy_original(evidence, object_store=store) is True
    evidence.refresh_from_db()
    assert evidence.s3_object_key != old_key and "/enc/" in evidence.s3_object_key
    assert evidence.encryption_key_ref
    assert old_key in store.objects  # под WORM старый объект не трогаем
    content = services.download_original(evidence, user=customer, object_store=store)
    assert pipeline.compute_sha256(content) == evidence.file_hash

    assert services.encrypt_legacy_original(evidence, object_store=store) is False


def test_encrypt_legacy_original_skips_hash_mismatch(signed, contractor, store):
    contract, milestone = signed
    evidence = _legacy_plaintext_row(contract, milestone, contractor, store)
    store.objects[evidence.s3_object_key] = b"tampered"

    assert services.encrypt_legacy_original(evidence, object_store=store) is False
    evidence.refresh_from_db()
    assert evidence.encryption_key_ref == ""


def test_encrypt_legacy_original_delete_plaintext_removes_old_object(signed, contractor, store):
    contract, milestone = signed
    evidence = _legacy_plaintext_row(contract, milestone, contractor, store)
    old_key = evidence.s3_object_key
    assert services.encrypt_legacy_original(evidence, object_store=store, delete_plaintext=True)
    assert old_key not in store.objects


def test_backfill_command_encrypts_pending_rows(signed, contractor):
    contract, milestone = signed
    store = build_evidence_object_store()  # команда берёт хранилище из настроек (fake)
    evidence = _legacy_plaintext_row(contract, milestone, contractor, store)
    out = StringIO()

    call_command("evidence_encrypt_backfill", batch_size=1, stdout=out)

    evidence.refresh_from_db()
    assert evidence.encryption_key_ref
    assert "перешифровано: 1" in out.getvalue()
    out = StringIO()
    call_command("evidence_encrypt_backfill", stdout=out)
    assert "к перешифрованию: 0" in out.getvalue()


def test_backfill_command_dry_run_changes_nothing(signed, contractor):
    contract, milestone = signed
    evidence = _legacy_plaintext_row(contract, milestone, contractor, build_evidence_object_store())
    call_command("evidence_encrypt_backfill", dry_run=True, stdout=StringIO())
    evidence.refresh_from_db()
    assert evidence.encryption_key_ref == ""


@override_settings(WORM_MODE="bucket_lock")
def test_backfill_command_refuses_delete_plaintext_under_worm():
    with pytest.raises(CommandError):
        call_command("evidence_encrypt_backfill", delete_plaintext=True, stdout=StringIO())
