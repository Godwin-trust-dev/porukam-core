"""Use cases apps.archive (ADR-139): постановка сборки, сама сборка
(Celery-задача -> `build_export`), выдача обеим сторонам (ЛК + юрзначимое
письмо с пакетом + ссылки), долгоживущие ссылки `/a/<token>`, отзыв,
реакция на уничтожение оригиналов.

Границы: contracts/milestones/payments/disputes/evidence — только фасады и
селекторы (см. selectors.py); уведомления — `apps.notifications.services.
place_notification`; Vault — `apps.audit.client`. Реакции на чужие события —
подписчиками `apps.archive.handlers`, не вызовами из чужих сервисов.

Ограничение Cloudflare 125 с (ADR-137 треб. 10): `request_export` только
создаёт строку и ставит задачу после коммита; ни байта zip в запросе."""

from __future__ import annotations

import base64
import hashlib
import logging
import secrets
from datetime import datetime
from typing import Any
from uuid import UUID

from django.conf import settings as django_settings
from django.core.cache import cache
from django.db import transaction
from django.db.models import F
from django.utils import timezone

from apps.accounts.models import User
from apps.audit import client as audit_client
from apps.contracts import selectors as contracts_selectors
from apps.contracts import services as contracts_services
from apps.contracts.models import Contract
from apps.evidence import selectors as evidence_selectors
from apps.evidence import services as evidence_services
from apps.evidence.models import Evidence
from apps.evidence.storage import EvidenceObjectStore, build_evidence_object_store
from apps.notifications import services as notifications_services
from apps.notifications.providers import EmailProvider
from common import crypto, outbox

from . import package, selectors
from .models import ArchiveExport, ArchiveLink
from .storage import ARCHIVE_KEY_PREFIX, ArchiveObjectStore, build_archive_object_store

logger = logging.getLogger(__name__)

_STATUS = ArchiveExport.Status
_FILES = ArchiveExport.FilesState
_KIND = ArchiveLink.Kind

# Субъекты конверта (common.crypto): РАЗНЫЕ для файлов и пакета — файлы
# уничтожаются по сроку (ключ), пакет живёт бессрочно. Токен ссылки — свой
# субъект: отзыв = уничтожение ключа, повторно показать URL уже нельзя.
FILES_SUBJECT_TYPE = "archive_files"
PACKAGE_SUBJECT_TYPE = "archive_package"
LINK_SUBJECT_TYPE = "archive_link"

ARCHIVE_READY_TEMPLATE = "archive.ready"


class NothingToExportError(ValueError):
    """Черновик без единой заморозки — «пока нечего собирать» (DEV-12)."""


class ExportOptionsConflictError(ValueError):
    """`include_originals` и `manifest_only` взаимоисключающие (DEV-12 §4)."""


class ExportNotReadyError(ValueError):
    """Артефакт запрошен у экспорта, который ещё не собран / не собрался."""


class ArchiveLinkNotFoundError(LookupError):
    """Токен не найден — 404 (не раскрываем, был ли он когда-то)."""


class ArchiveLinkRevokedError(ValueError):
    """Ссылка отозвана стороной — 410."""


class ArchiveFilesShreddedError(ValueError):
    """Файлы удалены по сроку хранения (ADR-137: ссылка живёт дольше данных,
    отвечает 410 со сведениями о дате удаления и хешами)."""


class ArchiveLinkRateLimitedError(ValueError):
    """Слишком много обращений к `/a/<token>` с одного адреса — 429."""


class NotLinkPartyError(ValueError):
    """Отзыв чужой ссылки (не сторона договора)."""


# --- постановка --------------------------------------------------------------


def _party_users(contract: Contract) -> list[tuple[str, User]]:
    pairs: list[tuple[str, User]] = []
    for party in contracts_selectors.list_parties(contract).order_by("role"):
        user = contracts_selectors.party_user(party)
        if user is not None:
            pairs.append((party.role, user))
    return pairs


def _contract_payload(contract: Contract, **extra: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "contract_id": str(contract.id),
        "parties": contracts_selectors.party_identity_snapshot(contract),
        "occurred_at": timezone.now().isoformat(),
    }
    payload.update(extra)
    return payload


def _publish(
    topic: str, export: ArchiveExport, *, actor: dict[str, Any] | None = None, **extra: object
) -> None:
    outbox.publish(
        topic,
        subject={
            "type": "archive_export",
            "id": str(export.id),
            "contract_id": str(export.contract_id),
        },
        payload=_contract_payload(export.contract, export_id=str(export.id), **extra),
        actor=actor or {},
    )


def _enqueue_build(export_id: UUID) -> None:
    from . import tasks

    tasks.build_archive_export.delay(str(export_id))


@transaction.atomic
def request_export(
    contract: Contract,
    *,
    user: User | None,
    include_originals: bool = True,
    manifest_only: bool = False,
    trigger: str = ArchiveExport.Trigger.MANUAL,
) -> ArchiveExport:
    """`POST /contracts/{id}/archive/export` -> 202 и автоэкспорт при
    завершении (`user=None`, trigger=auto). Идемпотентно поверх
    Idempotency-Key: идущая сборка с теми же опциями возвращается как есть.
    Задача ставится ПОСЛЕ коммита (иначе воркер не увидит строку)."""
    if user is not None:
        contracts_services.get_party_for_user(contract, user)
    if include_originals and manifest_only:
        raise ExportOptionsConflictError("include_originals и manifest_only взаимоисключающие")
    if not selectors.can_export(contract):
        raise NothingToExportError(f"по договору {contract.id} нет ни одной замороженной версии")

    existing = selectors.find_active_export(
        contract, include_originals=include_originals, manifest_only=manifest_only
    )
    if existing is not None:
        return existing

    export = ArchiveExport.objects.create(
        contract=contract,
        requested_by=user,
        trigger=trigger,
        include_originals=include_originals,
        manifest_only=manifest_only,
        is_snapshot=not selectors.is_ended(contract),
        snapshot_at=timezone.now(),
        files_state=_FILES.NOT_REQUESTED if manifest_only else _FILES.PENDING,
    )
    _publish(
        "archive.export_requested",
        export,
        actor={"user_id": str(user.id)} if user is not None else None,
        trigger=trigger,
        include_originals=include_originals,
        manifest_only=manifest_only,
    )
    transaction.on_commit(lambda: _enqueue_build(export.id))
    return export


@transaction.atomic
def request_auto_export(contract: Contract) -> ArchiveExport | None:
    """ADR-137 треб. 1: окончание сделки -> архив ОБЕИМ сторонам, не по
    желанию одной. Один автоэкспорт на договор (повторная доставка
    события / второе «окончание» — NOOP). Черновик без версий — нечего."""
    if ArchiveExport.objects.filter(contract=contract, trigger=ArchiveExport.Trigger.AUTO).exists():
        return None
    if not selectors.can_export(contract):
        return None
    return request_export(
        contract,
        user=None,
        include_originals=True,
        manifest_only=False,
        trigger=ArchiveExport.Trigger.AUTO,
    )


# --- сборка ----------------------------------------------------------------------


def _object_key(export: ArchiveExport, name: str) -> str:
    return f"{ARCHIVE_KEY_PREFIX}{export.contract_id}/{export.id}/{name}"


def _files_expires_at(contract_id: UUID) -> datetime | None:
    summary = evidence_selectors.retention_summary(contract_id)
    raw = summary.get("archive_until")
    return datetime.fromisoformat(str(raw)) if raw else None


def _collect_files(
    export: ArchiveExport, evidence_items: list[Evidence], *, evidence_store: EvidenceObjectStore
) -> tuple[list[package.PackageFile], set[str], set[str]]:
    """Оригиналы (расшифрованные — те же байты, что получил контрагент) и
    миниатюры. Уничтоженный/недоступный оригинал — пропуск с пометкой в
    манифесте (`original_included=false`), не срыв сборки."""
    files: list[package.PackageFile] = []
    included: set[str] = set()
    thumbnails: set[str] = set()
    for evidence in evidence_items:
        if evidence.thumbnail is not None:
            files.append(
                package.PackageFile(
                    package.thumbnail_path(str(evidence.id)), bytes(evidence.thumbnail)
                )
            )
            thumbnails.add(str(evidence.id))
        if not export.include_originals:
            continue
        content: bytes | None = None
        if evidence.storage_mode == Evidence.StorageMode.GLOBAL:
            content = bytes(evidence.transit_payload) if evidence.transit_payload else None
        elif evidence.s3_object_key:
            try:
                content = evidence_services.read_original_bytes(
                    evidence, object_store=evidence_store
                )
            except (evidence_services.EvidenceOriginalShreddedError, KeyError) as exc:
                logger.info("archive: оригинал %s недоступен: %s", evidence.id, exc)
        if content is None:
            continue
        if package.sha256_hex(content) != evidence.file_hash:
            # Доказательство важнее прогресса: расхождение с зафиксированным
            # хешем — не кладём, помечаем (тот же принцип, что backfill ADR-136).
            logger.warning("archive: хеш оригинала %s не совпал с file_hash — пропуск", evidence.id)
            continue
        files.append(
            package.PackageFile(
                package.evidence_file_path(str(evidence.id), evidence.file_name), content
            )
        )
        included.add(str(evidence.id))
    return files, included, thumbnails


def build_artifacts(
    export: ArchiveExport,
    *,
    evidence_store: EvidenceObjectStore | None = None,
) -> tuple[bytes, bytes | None, dict[str, Any], str, int]:
    """Чистая сборка: (package.zip, files.zip | None, manifest, SHA256SUMS,
    число доказательств). Детерминирована при неизменных данных — одинаковые
    байты при повторе (тест)."""
    store = evidence_store if evidence_store is not None else build_evidence_object_store()
    evidence_items = [
        e
        for e in evidence_selectors.list_for_contract(export.contract_id)
        if e.created_at <= export.snapshot_at
    ]
    files, included, thumbnails = _collect_files(export, evidence_items, evidence_store=store)
    if export.manifest_only:
        files, included, thumbnails = [], set(), set()
    record, infos = selectors.collect_record(
        export, evidence_items=evidence_items, included_ids=included, thumbnail_ids=thumbnails
    )
    checkpoint_files: list[package.PackageFile] = []
    openssl_commands: list[str] = []
    for info in infos:
        directory = f"checkpoint-{info.id}"
        checkpoint_files.append(
            package.PackageFile(
                f"{directory}.json", package.manifest_json(audit_client.checkpoint_record(info))
            )
        )
        for name, body in audit_client.checkpoint_files(info):
            checkpoint_files.append(package.PackageFile(f"{directory}/{name}", body))
        openssl_commands.extend(audit_client.checkpoint_openssl_commands(info, directory=directory))
    file_entries = [(f.path, package.sha256_hex(f.content)) for f in files]
    package_zip, sums = package.build_package(
        record,
        file_entries=file_entries,
        checkpoint_files=checkpoint_files,
        openssl_commands=openssl_commands,
        snapshot_at=export.snapshot_at,
    )
    files_zip = (
        package.build_zip(files, snapshot_at=export.snapshot_at)
        if not export.manifest_only
        else None
    )
    return package_zip, files_zip, record, sums, len(evidence_items)


def _link_token() -> tuple[str, str]:
    token = secrets.token_urlsafe(32)  # 256 бит (ADR-137: не менее 128)
    return token, hashlib.sha256(token.encode("ascii")).hexdigest()


def link_url(token: str) -> str:
    base = str(django_settings.ARCHIVE_LINK_BASE_URL).rstrip("/")
    return f"{base}/a/{token}"


def _create_link(
    export: ArchiveExport, *, kind: str, role: str, recipient: User
) -> tuple[ArchiveLink, str]:
    token, token_hash = _link_token()
    link = ArchiveLink.objects.create(
        export=export, kind=kind, party_role=role, recipient=recipient, token_hash=token_hash
    )
    encrypted = crypto.encrypt_bytes_for_subject(
        token.encode("ascii"), subject_type=LINK_SUBJECT_TYPE, subject_id=link.id
    )
    link.token_encrypted = encrypted.ciphertext
    link.token_key_ref = encrypted.key_ref
    link.save(update_fields=["token_encrypted", "token_key_ref"])
    return link, token


def link_token_for_party(link: ArchiveLink) -> str | None:
    """Токен для показа ЕГО владельцу (API стороны): расшифровка; после
    отзыва (ключ уничтожен) — None."""
    if link.revoked_at is not None or not link.token_key_ref or link.token_encrypted is None:
        return None
    try:
        return crypto.decrypt_bytes_for_subject(
            bytes(link.token_encrypted), link.token_key_ref
        ).decode("ascii")
    except crypto.SubjectKeyDestroyedError:
        return None


@transaction.atomic
def build_export(
    export: ArchiveExport,
    *,
    evidence_store: EvidenceObjectStore | None = None,
    archive_store: ArchiveObjectStore | None = None,
    email_provider: EmailProvider | None = None,
) -> ArchiveExport:
    """Тело Celery-задачи: собрать, зашифровать, положить, выдать сторонам.
    Идемпотентно по статусу: `ready` — NOOP (повторная доставка задачи)."""
    if export.status == _STATUS.READY:
        return export
    store = archive_store if archive_store is not None else build_archive_object_store()
    export.status = _STATUS.RUNNING
    export.started_at = timezone.now()
    export.save(update_fields=["status", "started_at"])

    package_zip, files_zip, record, sums, evidence_count = build_artifacts(
        export, evidence_store=evidence_store
    )
    encrypted_package = crypto.encrypt_bytes_for_subject(
        package_zip, subject_type=PACKAGE_SUBJECT_TYPE, subject_id=export.id
    )
    export.package_key = _object_key(export, "package.zip")
    store.put(
        export.package_key, encrypted_package.ciphertext, content_type="application/octet-stream"
    )
    export.package_size = len(package_zip)
    export.package_sha256 = package.sha256_hex(package_zip)
    export.package_key_ref = encrypted_package.key_ref

    if files_zip is not None:
        encrypted_files = crypto.encrypt_bytes_for_subject(
            files_zip, subject_type=FILES_SUBJECT_TYPE, subject_id=export.id
        )
        export.files_key = _object_key(export, "files.zip")
        store.put(
            export.files_key, encrypted_files.ciphertext, content_type="application/octet-stream"
        )
        export.files_size = len(files_zip)
        export.files_sha256 = package.sha256_hex(files_zip)
        export.files_key_ref = encrypted_files.key_ref
        export.files_state = _FILES.AVAILABLE
        export.files_expires_at = _files_expires_at(export.contract_id)

    export.manifest = record
    export.sha256sums = sums
    export.evidence_count = evidence_count
    export.status = _STATUS.READY
    export.finished_at = timezone.now()
    export.error = ""
    export.save()

    _publish(
        "archive.ready",
        export,
        package_sha256=export.package_sha256,
        package_size=export.package_size,
        files_sha256=export.files_sha256 or None,
        files_size=export.files_size,
        evidence_count=evidence_count,
        is_snapshot=export.is_snapshot,
        trigger=export.trigger,
    )
    deliver_export(export, package_zip=package_zip, email_provider=email_provider)
    return export


def mark_failed(export: ArchiveExport, *, error: str) -> None:
    ArchiveExport.objects.filter(pk=export.pk).update(
        status=_STATUS.FAILED, error=error[:2000], finished_at=timezone.now()
    )


# --- выдача обеим сторонам -----------------------------------------------------


def deliver_export(
    export: ArchiveExport, *, package_zip: bytes, email_provider: EmailProvider | None = None
) -> list[ArchiveLink]:
    """ADR-137 треб. 1-2: обеим сторонам — размещение в ЛК (юрканал) + письмо
    с пакетом ВО ВЛОЖЕНИИ (< `ARCHIVE_EMAIL_ATTACHMENT_MAX_BYTES`, иначе
    только ссылка) + долгоживущие ссылки на пакет и файлы. Письмо уходит
    независимо от настройки e-mail (`force_email`, решение владельца 26.08);
    нет адреса — ЛК + попытка `no_email`."""
    attach = len(package_zip) <= django_settings.ARCHIVE_EMAIL_ATTACHMENT_MAX_BYTES
    attachments = (
        [
            {
                "filename": f"porukam-{selectors.contract_number(export.contract)[2:]}-package.zip",
                "content_type": "application/zip",
                "content_b64": base64.b64encode(package_zip).decode("ascii"),
            }
        ]
        if attach
        else []
    )
    created: list[ArchiveLink] = []
    for role, user in _party_users(export.contract):
        package_link, package_token = _create_link(
            export, kind=_KIND.PACKAGE, role=role, recipient=user
        )
        created.append(package_link)
        payload: dict[str, Any] = {
            "contract_id": str(export.contract_id),
            "export_id": str(export.id),
            "package_url": link_url(package_token),
            "package_size": export.package_size,
            "package_sha256": export.package_sha256,
            "package_attached": attach,
            "is_snapshot": export.is_snapshot,
            "evidence_count": export.evidence_count,
        }
        if export.files_state == _FILES.AVAILABLE:
            files_link, files_token = _create_link(
                export, kind=_KIND.FILES, role=role, recipient=user
            )
            created.append(files_link)
            payload["files_url"] = link_url(files_token)
            payload["files_size"] = export.files_size
            payload["files_expires_at"] = (
                export.files_expires_at.isoformat() if export.files_expires_at else None
            )
        notifications_services.place_notification(
            recipient=user,
            template=ARCHIVE_READY_TEMPLATE,
            payload=payload,
            legal_significance=True,
            subject_type="contract",
            subject_id=str(export.contract_id),
            force_email=True,
            email_attachments=attachments,
            email_provider=email_provider,
        )
    export.delivered_at = timezone.now()
    export.save(update_fields=["delivered_at"])
    return created


# --- чтение артефактов ----------------------------------------------------------


def read_artifact(
    export: ArchiveExport, *, kind: str, archive_store: ArchiveObjectStore | None = None
) -> bytes:
    if export.status != _STATUS.READY:
        raise ExportNotReadyError(f"экспорт {export.id} в состоянии {export.status}")
    store = archive_store if archive_store is not None else build_archive_object_store()
    if kind == _KIND.PACKAGE:
        return crypto.decrypt_bytes_for_subject(
            store.get(export.package_key), export.package_key_ref
        )
    if export.files_state != _FILES.AVAILABLE or not export.files_key:
        raise ArchiveFilesShreddedError(f"файлы экспорта {export.id}: {export.files_state}")
    try:
        return crypto.decrypt_bytes_for_subject(store.get(export.files_key), export.files_key_ref)
    except crypto.SubjectKeyDestroyedError as exc:
        raise ArchiveFilesShreddedError(f"ключ файлов экспорта {export.id} уничтожен") from exc


# --- ссылки /a/<token> -------------------------------------------------------------


def _link_rate_limit_key(client_ip: str) -> str:
    return f"archive:links:{client_ip}"


def check_link_rate_limit(client_ip: str) -> None:
    """Тот же приём, что лимит загрузок доказательств: счётчик в кеше по
    адресу (ссылка без авторизации — единственная ручка, ADR-137)."""
    key = _link_rate_limit_key(client_ip or "unknown")
    try:
        count = int(cache.incr(key))
    except ValueError:
        cache.set(key, 1, timeout=django_settings.ARCHIVE_LINK_RATE_WINDOW_SECONDS)
        count = 1
    if count > django_settings.ARCHIVE_LINK_RATE_LIMIT:
        raise ArchiveLinkRateLimitedError(f"адрес {client_ip} превысил лимит обращений к архиву")


def resolve_link(token: str) -> ArchiveLink:
    token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
    link = (
        ArchiveLink.objects.select_related("export__contract").filter(token_hash=token_hash).first()
    )
    if link is None:
        raise ArchiveLinkNotFoundError("ссылка не найдена")
    if link.revoked_at is not None:
        raise ArchiveLinkRevokedError(f"ссылка {link.id} отозвана")
    return link


@transaction.atomic
def record_link_access(link: ArchiveLink, *, outcome: str) -> None:
    """Лог обращений (ADR-137): счётчик + событие `archive.link_accessed` в
    outbox -> Audit Vault. Без IP/UA — Vault бессрочен, ПД туда не пишем."""
    ArchiveLink.objects.filter(pk=link.pk).update(
        access_count=F("access_count") + 1, last_access_at=timezone.now()
    )
    _publish(
        "archive.link_accessed",
        link.export,
        link_id=str(link.id),
        kind=link.kind,
        party_role=link.party_role,
        outcome=outcome,
    )


@transaction.atomic
def revoke_link(link: ArchiveLink, *, user: User) -> ArchiveLink:
    """`POST /archive/links/{id}/revoke` — любая сторона договора (письмо
    могло утечь у любой из них). Идемпотентно. Ключ токена уничтожается:
    показать URL повторно уже нельзя."""
    contracts_services.get_party_for_user(link.export.contract, user)
    if link.revoked_at is not None:
        return link
    link.revoked_at = timezone.now()
    link.save(update_fields=["revoked_at"])
    crypto.destroy_subject_key(LINK_SUBJECT_TYPE, link.id)
    _publish(
        "archive.link_revoked",
        link.export,
        actor={"user_id": str(user.id)},
        link_id=str(link.id),
        kind=link.kind,
        party_role=link.party_role,
    )
    return link


# --- срок хранения (подписчик на evidence.shredded) -----------------------------


@transaction.atomic
def shred_export_files(
    contract_id: UUID, *, archive_store: ArchiveObjectStore | None = None
) -> int:
    """`evidence.shredded` -> файлы всех экспортов договора: ключ конверта
    уничтожен, объект удалён, `files_state=shredded`. `package.zip` НЕ
    трогается (ADR-137 треб. 5-6). Идемпотентно по `files_state`.
    Аудит фактического удаления (треб. 7): событие `archive.files_shredded`
    + строка лога на экспорт."""
    store = archive_store if archive_store is not None else build_archive_object_store()
    now = timezone.now()
    count = 0
    for export in ArchiveExport.objects.filter(
        contract_id=contract_id, files_state=_FILES.AVAILABLE
    ).select_related("contract"):
        crypto.destroy_subject_key(FILES_SUBJECT_TYPE, export.id)
        if export.files_key:
            store.delete(export.files_key)
        export.files_key = ""
        export.files_state = _FILES.SHREDDED
        export.files_shredded_at = now
        export.save(update_fields=["files_key", "files_state", "files_shredded_at"])
        logger.info(
            "archive retention: files.zip экспорта %s договора %s удалён (sha256 %s сохранён)",
            export.id,
            contract_id,
            export.files_sha256,
        )
        _publish("archive.files_shredded", export, files_sha256=export.files_sha256)
        count += 1
    return count
