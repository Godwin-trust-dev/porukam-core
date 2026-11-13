"""apps.evidence.services — ГВ.3 (docs/tasks/global-wave.md). Приёмка:
у платформы только hash+миниатюра (S3 без оригинала — GLOBAL), контрагент
получил файл, копия в фейк-Drive, сверка ловит подмену, EXIF вычищен,
RU-режим — флагом."""

from __future__ import annotations

import pytest
from django.test import override_settings

from apps.evidence import selectors, services
from apps.evidence.models import Evidence
from apps.evidence.providers import FakeGoogleDriveBackupProvider
from apps.evidence.storage import FakeEvidenceObjectStore
from apps.milestones.tests._execution_helpers import (
    add_checklist_item_with_evidence,
    make_signed_contract_with_leaf,
    make_user,
)

from ._fixtures import jpeg_with_gps_exif_and_thumbnail, jpeg_without_exif

pytestmark = pytest.mark.django_db(databases=["default", "audit"])


@pytest.fixture(autouse=True)
def _legacy_global_path():
    """ГВ.3-путь «хеш у платформы, оригинал у сторон» — с 26.08 выключен
    ДАННЫМИ (jurisdictions/0009, ADR-136 «Отмена части ГВ.3»), код жив ради
    обратимости и проверяется здесь при явно выключенном флаге контура.
    Серверное хранение во всех контурах — apps/evidence/tests/
    test_encryption.py."""
    from apps.jurisdictions.models import GLOBAL_COUNTRY_CODE, JurisdictionConfig

    JurisdictionConfig.objects.filter(country_code=GLOBAL_COUNTRY_CODE).update(
        evidence_server_storage_enabled=False
    )


@pytest.fixture
def customer():
    return make_user("ev001")


@pytest.fixture
def contractor():
    return make_user("ev002")


@pytest.fixture
def signed(customer, contractor):
    return make_signed_contract_with_leaf(customer=customer, contractor=contractor)


@pytest.fixture
def store():
    return FakeEvidenceObjectStore()


# --- GLOBAL: hash+миниатюра+метаданные у платформы, S3 пуст ------------------


def test_upload_evidence_global_mode_no_s3_write(signed, customer, store):
    contract, milestone = signed
    evidence = services.upload_evidence(
        contract,
        user=customer,
        content=jpeg_with_gps_exif_and_thumbnail(),
        file_name="photo.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        object_store=store,
    )
    assert evidence.storage_mode == Evidence.StorageMode.GLOBAL
    assert evidence.s3_object_key == ""
    assert store.objects == {}  # ключевая проверка приёмки: S3 не тронут
    assert evidence.file_hash
    assert evidence.thumbnail == b"\xff\xd8\xff\xd9"
    assert evidence.transit_payload is not None  # временно, до доставки


def test_upload_evidence_exif_stripped_in_stored_state(signed, customer, store):
    contract, milestone = signed
    evidence = services.upload_evidence(
        contract,
        user=customer,
        content=jpeg_with_gps_exif_and_thumbnail(make="Acme", model="Zoom"),
        file_name="photo.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        object_store=store,
    )
    assert evidence.metadata["gps_stripped"] is True
    assert b"Exif" not in bytes(evidence.transit_payload)
    assert b"Acme" not in bytes(evidence.transit_payload)
    assert b"Acme" not in bytes(evidence.thumbnail)


def test_upload_evidence_requires_milestone_or_dispute(signed, customer):
    contract, _milestone = signed
    with pytest.raises(services.EvidenceNotAttachedError):
        services.upload_evidence(
            contract,
            user=customer,
            content=jpeg_without_exif(),
            file_name="x.jpg",
            mime_type="image/jpeg",
        )


def test_upload_evidence_checklist_item_wrong_milestone(signed, customer, contractor):
    contract, milestone = signed
    _contract2, milestone2 = make_signed_contract_with_leaf(
        customer=make_user("ev003"), contractor=make_user("ev004")
    )
    item = add_checklist_item_with_evidence(milestone2)
    with pytest.raises(services.ChecklistItemNotOnMilestoneError):
        services.upload_evidence(
            contract,
            user=customer,
            content=jpeg_without_exif(),
            file_name="x.jpg",
            mime_type="image/jpeg",
            milestone_id=milestone.id,
            checklist_item_id=item.id,
        )


def test_upload_evidence_by_stranger_is_forbidden(signed):
    from apps.contracts import services as contracts_services

    contract, milestone = signed
    stranger = make_user("ev005")
    with pytest.raises(contracts_services.NotAPartyError):
        services.upload_evidence(
            contract,
            user=stranger,
            content=jpeg_without_exif(),
            file_name="x.jpg",
            mime_type="image/jpeg",
            milestone_id=milestone.id,
        )


# --- Релей контрагенту: доставка + удаление оригинала (GLOBAL) --------------


def test_download_by_counterparty_marks_delivered_and_purges_original(
    signed, customer, contractor, store
):
    contract, milestone = signed
    evidence = services.upload_evidence(
        contract,
        user=contractor,
        content=jpeg_without_exif(),
        file_name="x.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        object_store=store,
    )
    content = services.download_original(evidence, user=customer, object_store=store)
    assert content == jpeg_without_exif()

    evidence.refresh_from_db()
    assert evidence.delivery_status == Evidence.DeliveryStatus.DELIVERED
    assert evidence.delivered_to_counterparty_at is not None
    assert evidence.transit_payload is None  # удалён после подтверждённой доставки


def test_download_by_uploader_does_not_count_as_delivery(signed, customer, contractor, store):
    contract, milestone = signed
    evidence = services.upload_evidence(
        contract,
        user=contractor,
        content=jpeg_without_exif(),
        file_name="x.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        object_store=store,
    )
    services.download_original(evidence, user=contractor, object_store=store)
    evidence.refresh_from_db()
    assert evidence.delivery_status == Evidence.DeliveryStatus.IN_TRANSIT
    assert evidence.transit_payload is not None


def test_download_after_purge_is_unavailable(signed, customer, contractor, store):
    contract, milestone = signed
    evidence = services.upload_evidence(
        contract,
        user=contractor,
        content=jpeg_without_exif(),
        file_name="x.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        object_store=store,
    )
    services.download_original(evidence, user=customer, object_store=store)  # доставлено, удалено
    with pytest.raises(services.EvidenceOriginalUnavailableError):
        services.download_original(evidence, user=customer, object_store=store)


# --- RU-режим: флагом, оригинал в S3, не удаляется ---------------------------


def test_upload_evidence_ru_mode_writes_to_s3_and_keeps_original(signed, contractor, store):
    contract, milestone = signed
    contractor.country_code = "RU"
    contractor.save(update_fields=["country_code"])

    evidence = services.upload_evidence(
        contract,
        user=contractor,
        content=jpeg_without_exif(),
        file_name="x.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        object_store=store,
    )
    assert evidence.storage_mode == Evidence.StorageMode.SERVER
    assert evidence.transit_payload is None
    assert evidence.s3_object_key in store.objects
    # ADR-136: в бакете шифротекст конверта, открытые байты — через
    # расшифровку (apps/evidence/tests/test_encryption.py — подробно).
    assert store.objects[evidence.s3_object_key] != jpeg_without_exif()
    assert services.read_original_bytes(evidence, object_store=store) == jpeg_without_exif()


def test_download_ru_mode_never_purges(signed, customer, contractor, store):
    contract, milestone = signed
    contractor.country_code = "RU"
    contractor.save(update_fields=["country_code"])
    evidence = services.upload_evidence(
        contract,
        user=contractor,
        content=jpeg_without_exif(),
        file_name="x.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        object_store=store,
    )
    services.download_original(evidence, user=customer, object_store=store)
    services.download_original(
        evidence, user=customer, object_store=store
    )  # второй раз — не падает
    assert evidence.s3_object_key in store.objects  # RU: оригинал остаётся навсегда


# --- Сверка предъявленного файла с хешом -------------------------------------


def test_verify_hash_matches_relayed_content(signed, customer, contractor, store):
    contract, milestone = signed
    content = jpeg_with_gps_exif_and_thumbnail()
    evidence = services.upload_evidence(
        contract,
        user=contractor,
        content=content,
        file_name="x.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        object_store=store,
    )
    relayed = services.download_original(evidence, user=customer, object_store=store)
    assert services.verify_hash(evidence, presented_content=relayed, user=customer) is True


def test_verify_hash_catches_tampering(signed, customer, contractor, store):
    contract, milestone = signed
    evidence = services.upload_evidence(
        contract,
        user=contractor,
        content=jpeg_without_exif(),
        file_name="x.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        object_store=store,
    )
    tampered = jpeg_without_exif() + b"\x00extra-byte"
    assert services.verify_hash(evidence, presented_content=tampered, user=customer) is False


# --- BYO-бэкап в Google Drive -------------------------------------------------


def test_request_backup_success(signed, customer, contractor, store):
    from apps.accounts.models import SocialLoginAccount

    contract, milestone = signed
    SocialLoginAccount.objects.create(
        user=contractor, provider="google", sub="sub-1", email="a@x.com"
    )
    evidence = services.upload_evidence(
        contract,
        user=contractor,
        content=jpeg_without_exif(),
        file_name="x.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        object_store=store,
    )
    provider = FakeGoogleDriveBackupProvider()
    result = services.request_backup(
        evidence, user=contractor, provider=provider, object_store=store
    )
    assert result.backup_status == Evidence.BackupStatus.COMPLETED
    assert result.backup_completed_at is not None
    assert len(provider.uploads) == 1


def test_request_backup_failure_is_non_blocking(signed, customer, contractor, store):
    from apps.accounts.models import SocialLoginAccount

    contract, milestone = signed
    SocialLoginAccount.objects.create(
        user=contractor, provider="google", sub="sub-1", email="a@x.com"
    )
    evidence = services.upload_evidence(
        contract,
        user=contractor,
        content=jpeg_without_exif(),
        file_name="x.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        object_store=store,
    )
    provider = FakeGoogleDriveBackupProvider(fail=True)
    result = services.request_backup(
        evidence, user=contractor, provider=provider, object_store=store
    )
    # Отказ виден честно, но не поднимает исключение и не трогает сам файл.
    assert result.backup_status == Evidence.BackupStatus.FAILED
    assert result.backup_failure_reason
    result.refresh_from_db()
    assert result.transit_payload is not None  # доказательство не пострадало


def test_request_backup_without_linked_google_account(signed, customer, contractor, store):
    contract, milestone = signed
    evidence = services.upload_evidence(
        contract,
        user=contractor,
        content=jpeg_without_exif(),
        file_name="x.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        object_store=store,
    )
    result = services.request_backup(
        evidence, user=contractor, provider=FakeGoogleDriveBackupProvider(), object_store=store
    )
    assert result.backup_status == Evidence.BackupStatus.FAILED
    assert "Google" in result.backup_failure_reason


def test_request_backup_is_idempotent_does_not_reupload(signed, customer, contractor, store):
    """ADR-084/§2.3: повторный POST /evidence/{id}/backup после COMPLETED не
    шлёт файл в Drive второй раз (нет дублей в Drive пользователя)."""
    from apps.accounts.models import SocialLoginAccount

    contract, milestone = signed
    SocialLoginAccount.objects.create(
        user=contractor, provider="google", sub="sub-1", email="a@x.com"
    )
    evidence = services.upload_evidence(
        contract,
        user=contractor,
        content=jpeg_without_exif(),
        file_name="x.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        object_store=store,
    )
    provider = FakeGoogleDriveBackupProvider()
    services.request_backup(evidence, user=contractor, provider=provider, object_store=store)
    assert len(provider.uploads) == 1

    result = services.request_backup(
        evidence, user=contractor, provider=provider, object_store=store
    )
    assert len(provider.uploads) == 1  # второй upload() не вызван
    assert result.backup_status == Evidence.BackupStatus.COMPLETED


def test_request_backup_persists_drive_file_id_and_link(signed, customer, contractor, store):
    from apps.accounts.models import SocialLoginAccount

    contract, milestone = signed
    SocialLoginAccount.objects.create(
        user=contractor, provider="google", sub="sub-1", email="a@x.com"
    )
    evidence = services.upload_evidence(
        contract,
        user=contractor,
        content=jpeg_without_exif(),
        file_name="x.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        object_store=store,
    )
    result = services.request_backup(
        evidence, user=contractor, provider=FakeGoogleDriveBackupProvider(), object_store=store
    )
    assert result.backup_drive_file_id == "fake-drive-file-1"
    assert result.backup_drive_web_view_link == "https://drive.fake.local/file/1"


def test_request_backup_via_real_provider_without_grant_soft_fails(
    signed, customer, contractor, store
):
    """RealGoogleDriveBackupProvider без Drive-гранта — та же деградация,
    что «нет привязанного Google» (200 + backup_status=failed, не 500):
    docs/tasks/Задача_feat_evidence-drive.md §2.3."""
    from apps.accounts.models import SocialLoginAccount
    from apps.accounts.providers import FakeGoogleDriveOAuthProvider
    from apps.evidence.providers import RealGoogleDriveBackupProvider

    contract, milestone = signed
    SocialLoginAccount.objects.create(
        user=contractor, provider="google", sub="sub-real-1", email="a@x.com"
    )
    evidence = services.upload_evidence(
        contract,
        user=contractor,
        content=jpeg_without_exif(),
        file_name="x.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        object_store=store,
    )
    provider = RealGoogleDriveBackupProvider(oauth_provider=FakeGoogleDriveOAuthProvider())
    result = services.request_backup(
        evidence, user=contractor, provider=provider, object_store=store
    )
    assert result.backup_status == Evidence.BackupStatus.FAILED
    assert "Drive не подключён" in result.backup_failure_reason


def test_request_backup_via_real_provider_revoked_grant_soft_fails(
    signed, customer, contractor, store
):
    from apps.accounts import services as accounts_services
    from apps.accounts.models import SocialLoginAccount
    from apps.accounts.providers import FakeGoogleDriveOAuthProvider
    from apps.evidence.providers import RealGoogleDriveBackupProvider

    contract, milestone = signed
    SocialLoginAccount.objects.create(
        user=contractor, provider="google", sub="sub-real-2", email="a@x.com"
    )
    drive_provider = FakeGoogleDriveOAuthProvider()
    _url, state = accounts_services.build_drive_connect_authorize_url(
        contractor, provider=drive_provider
    )
    accounts_services.complete_drive_connect(
        user=contractor, code="code-real-2", state=state, provider=drive_provider
    )
    accounts_services.revoke_drive_grant(contractor)

    evidence = services.upload_evidence(
        contract,
        user=contractor,
        content=jpeg_without_exif(),
        file_name="x.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        object_store=store,
    )
    provider = RealGoogleDriveBackupProvider(oauth_provider=drive_provider)
    result = services.request_backup(
        evidence, user=contractor, provider=provider, object_store=store
    )
    assert result.backup_status == Evidence.BackupStatus.FAILED
    assert "отозван" in result.backup_failure_reason


# --- Лимиты: настройки, не константы -----------------------------------------


@override_settings(EVIDENCE_MAX_FILE_SIZE_BYTES=10)
def test_upload_evidence_too_large_is_rejected(signed, contractor):
    contract, milestone = signed
    with pytest.raises(services.EvidenceTooLargeError):
        services.upload_evidence(
            contract,
            user=contractor,
            content=jpeg_without_exif(),
            file_name="x.jpg",
            mime_type="image/jpeg",
            milestone_id=milestone.id,
        )


@override_settings(EVIDENCE_UPLOAD_RATE_LIMIT=1)
def test_upload_evidence_rate_limited(signed, contractor):
    contract, milestone = signed
    services.upload_evidence(
        contract,
        user=contractor,
        content=jpeg_without_exif(),
        file_name="a.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
    )
    with pytest.raises(services.EvidenceUploadRateLimitedError):
        services.upload_evidence(
            contract,
            user=contractor,
            content=jpeg_without_exif(),
            file_name="b.jpg",
            mime_type="image/jpeg",
            milestone_id=milestone.id,
        )


def test_uncovered_checklist_items_after_upload(signed, contractor):
    """ADR-164: селектор отвечает СПИСКОМ непокрытых пунктов (был булев
    `required_evidence_covered` — ответ жёсткого гейта сдачи, который снят)."""
    contract, milestone = signed
    item = add_checklist_item_with_evidence(milestone)
    assert selectors.uncovered_checklist_items(checklist_item_ids=[item.id]) == {item.id}
    services.upload_evidence(
        contract,
        user=contractor,
        content=jpeg_without_exif(),
        file_name="x.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        checklist_item_id=item.id,
    )
    assert selectors.uncovered_checklist_items(checklist_item_ids=[item.id]) == set()


def test_uncovered_checklist_items_without_ids_is_empty():
    """Пустой вход — пустой ответ: этап без «фотопунктов» (обычный случай)
    не платит лишним запросом."""
    assert selectors.uncovered_checklist_items(checklist_item_ids=[]) == set()
