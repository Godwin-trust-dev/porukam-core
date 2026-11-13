"""Use cases apps.evidence — ГВ.3 (docs/tasks/global-wave.md): evidence в
GLOBAL-режиме, hash у платформы, оригиналы у сторон; Э6 (ADR-136,
docs/adr/ADR-136-evidence-etap6-foundation.md): шифрование оригиналов at
rest, RetentionTimer (ADR-036), окно выгрузки 72 ч / `lateness` (ADR-053),
серверная половина DeviceKey-манифеста (включение — Э10), дедуп по хешу.

Оркестрация вокруг чистого пайплайна `services/evidence_ingest/pipeline.py`
(вне Django, без побочных эффектов): здесь — транзакция, модель, релей
(уведомление + временное хранение до подтверждённой доставки), BYO-бэкап,
лимиты (настройки, не константы, п.4 задачи). `storage_mode` решается ОДИН
РАЗ на загрузке по `JurisdictionConfig.evidence_server_storage_enabled`
контура ЗАГРУЗИВШЕГО (ГВ.1 fallback-резолвер) — RU-ветка (S3, постоянное
хранение) остаётся в коде за этим флагом, GLOBAL его не включает (общие
требования волны ГВ).

Границы (import-linter): apps.deadlines — только services/selectors;
apps.authority — фасад `assignment_valid_at`; apps.disputes — только
selectors (`has_open_disputes`); реакции на чужие события — подписчиками
`apps.evidence.handlers`, не вызовами из чужих сервисов."""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from django.conf import settings as django_settings
from django.core.cache import cache
from django.db import transaction
from django.utils import timezone

from apps.accounts.models import DeviceKey, SocialLoginAccount, User
from apps.authority import selectors as authority_selectors
from apps.authority import services as authority_services
from apps.contracts import selectors as contracts_selectors
from apps.contracts import services as contracts_services
from apps.contracts.models import Contract
from apps.deadlines import selectors as deadlines_selectors
from apps.deadlines import services as deadlines_services
from apps.deadlines.models import DomainDeadline
from apps.disputes import selectors as disputes_selectors
from apps.jurisdictions.selectors import resolve_jurisdiction
from apps.milestones.models import ChecklistItem, Milestone
from apps.notifications import services as notifications_services
from common import crypto, outbox
from common.timestamps import DEFAULT_TIMESTAMP_PROVIDER, TimestampProvider
from services.evidence_ingest import pipeline

from . import manifest as manifest_module
from .models import Evidence, RetentionTimer
from .providers import GoogleDriveBackupError, GoogleDriveBackupProvider
from .storage import EvidenceObjectStore, build_evidence_object_store

logger = logging.getLogger(__name__)

_STORAGE_MODE = Evidence.StorageMode
# Режимы «оригинал в бакете»: `server` (ADR-136, все контуры) и `ru`
# (строки до ADR-136) — один путь чтения/шифрования.
_SERVER_MODES = frozenset({Evidence.StorageMode.SERVER, Evidence.StorageMode.RU})
_DELIVERY_STATUS = Evidence.DeliveryStatus
_BACKUP_STATUS = Evidence.BackupStatus
_LATENESS = Evidence.Lateness
_RETENTION = Evidence.RetentionState
_TIMER_STATE = RetentionTimer.State

# Субъекты конвертного шифрования (common.crypto). Оригинал — свой субъект
# на каждый файл: crypto-shredding по сроку хранения = destroy_subject_key
# ровно этого файла. Гео — субъект «договор» (ADR-045: геометка = адрес
# объекта/квартиры заказчика, живёт и умирает вместе с ПД договора).
EVIDENCE_SUBJECT_TYPE = "evidence"
GEO_SUBJECT_TYPE = "contract"

# Категории DeadlineKindConfig (данные, deadlines/0009): окно выгрузки
# ADR-053 (дедлайна НЕ заводит — параметр расчёта lateness), три дедлайна
# RetentionTimer (ADR-036/137) и предел продления при споре (ADR-137).
UPLOAD_WINDOW_KIND = "evidence_upload_window"
HOT_RETENTION_KIND = "evidence_hot_retention"
ARCHIVE_RETENTION_KIND = "evidence_archive_retention"
RETENTION_NOTICE_KIND = "evidence_retention_notice"
DISPUTE_PAUSE_CAP_KIND = "evidence_dispute_pause_cap"
RETENTION_KINDS: tuple[str, ...] = (
    HOT_RETENTION_KIND,
    ARCHIVE_RETENTION_KIND,
    RETENTION_NOTICE_KIND,
)
# Этап, у которого приёмка уже состоялась — материал «после закрытия
# приёмки» (ADR-053: только в архив спора, на автоприёмку не влияет).
_ACCEPTED_MILESTONE_STATUSES = frozenset(
    {Milestone.Status.ACCEPTED, Milestone.Status.PAID, Milestone.Status.DISPUTED}
)


class EvidenceNotAttachedError(ValueError):
    """Ни `milestone`, ни `dispute` не переданы — тот же инвариант, что
    CheckConstraint `evidence_attached_to_milestone_or_dispute` в БД."""


class ChecklistItemNotOnMilestoneError(ValueError):
    """`checklist_item` не из переданного `milestone`."""


class EvidenceTooLargeError(ValueError):
    """Превышен `settings.EVIDENCE_MAX_FILE_SIZE_BYTES` (ГВ.3 п.4 — лимит,
    не константа)."""


class EvidenceUploadRateLimitedError(ValueError):
    """Превышена частота загрузок `settings.EVIDENCE_UPLOAD_RATE_LIMIT` за
    `EVIDENCE_UPLOAD_RATE_WINDOW_SECONDS` (ГВ.3 п.4, ADR-060 §9: защита от
    медиа-абьюза)."""


class EvidenceOriginalUnavailableError(ValueError):
    """GLOBAL-режим: оригинал уже удалён после подтверждённой доставки —
    честная деградация, «второй раз скачать» физически нечего (в этом и
    смысл GLOBAL: платформа не держит копию про запас)."""


class EvidenceOriginalShreddedError(ValueError):
    """Оригинал уничтожен по сроку хранения (ADR-036: ключ конверта
    уничтожен, retention_state=shredded) — хеш и миниатюра остались,
    скачанная ранее копия сохраняет доказательную силу."""


class DeviceManifestDisabledError(ValueError):
    """Манифест DeviceKey прислан, но приём выключен
    (`EVIDENCE_DEVICE_MANIFEST_ENABLED=false` до Р1-мобайл, Э10)."""


class DeviceManifestInvalidError(ValueError):
    """Манифест не разбирается / подпись не сходится / хеш не тот /
    ключ не этого пользователя или отозван до момента съёмки / манифест
    про другой договор или этап."""


class AssignmentNotValidError(ValueError):
    """`assignment_id` манифеста не действовал в момент съёмки
    (`apps.authority.services.assignment_valid_at`)."""


def _upload_rate_limit_cache_key(user_id: UUID) -> str:
    return f"evidence:uploads:{user_id}"


def _check_rate_limit(user: User) -> None:
    key = _upload_rate_limit_cache_key(user.id)
    try:
        count = int(cache.incr(key))
    except ValueError:
        cache.set(key, 1, timeout=django_settings.EVIDENCE_UPLOAD_RATE_WINDOW_SECONDS)
        count = 1
    if count > django_settings.EVIDENCE_UPLOAD_RATE_LIMIT:
        raise EvidenceUploadRateLimitedError(
            f"пользователь {user.id} превысил лимит загрузок доказательств"
        )


def _s3_key(evidence_id: UUID, file_name: str) -> str:
    return f"evidence/{evidence_id}/{file_name}"


def _s3_key_encrypted(evidence_id: UUID, file_name: str) -> str:
    """Ключ перешифрованной копии для backfill: под WORM перезаписать
    старый ключ нельзя, поэтому — новый (старый открытый объект остаётся до
    lifecycle-правила бакета либо `--delete-plaintext` в режиме none)."""
    return f"evidence/{evidence_id}/enc/{file_name}"


def _self_sufficient_payload(evidence: Evidence, **extra: object) -> dict[str, object]:
    """Самодостаточный payload (тот же принцип, что etap-4.md Э4.6 «доп.
    требование, док 31 §7»): договор, этап/спор, обе стороны, метка
    времени — событие не обязано полагаться на то, что связанные строки
    будут доступны позже тем же запросом."""
    payload: dict[str, object] = {
        "contract_id": str(evidence.contract_id),
        "evidence_id": str(evidence.id),
        "milestone_id": str(evidence.milestone_id) if evidence.milestone_id else None,
        "checklist_item_id": str(evidence.checklist_item_id)
        if evidence.checklist_item_id
        else None,
        "dispute_id": str(evidence.dispute_id) if evidence.dispute_id else None,
        "parties": contracts_selectors.party_identity_snapshot(evidence.contract),
        "occurred_at": timezone.now().isoformat(),
    }
    payload.update(extra)
    return payload


def _contract_payload(contract: Contract, **extra: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "contract_id": str(contract.id),
        "parties": contracts_selectors.party_identity_snapshot(contract),
        "occurred_at": timezone.now().isoformat(),
    }
    payload.update(extra)
    return payload


def _publish_contract_event(topic: str, contract: Contract, **extra: object) -> None:
    outbox.publish(
        topic,
        subject={"type": "contract", "id": str(contract.id)},
        payload=_contract_payload(contract, **extra),
        actor={},
    )


def is_strongly_protected(evidence: Evidence) -> bool:
    """Пометка «без усиленной доказательной защиты» (tech-spec.md §1.3,
    §14 п.17) — её ОТСУТСТВИЕ: есть подпись DeviceKey, проверенная при
    приёме. Веб-загрузка — всегда False, фронт показывает пометку."""
    return evidence.device_key_id is not None and evidence.device_signature is not None


# --- Окно выгрузки 72 ч (ADR-053) -------------------------------------------


def compute_lateness(
    *,
    captured_at_device: datetime | None,
    received_at: datetime,
    milestone_status: str | None,
    window: timedelta | None,
) -> str:
    """Три зоны ADR-053 + честное «неизвестно» (ADR-136 п.5).

    `after_acceptance` — по состоянию этапа на момент ЗАГРУЗКИ, независимо
    от времени съёмки: приёмка закрыта — материал только в архив спора.
    Без времени съёмки (веб-загрузка) — `unknown`, а не `on_time`: «в
    окне» утверждать нечем, число прислал бы сам клиент. С манифестом —
    разница «получено − снято по часам устройства» против окна
    (`evidence_upload_window`, параметр категории)."""
    if milestone_status is not None and milestone_status in _ACCEPTED_MILESTONE_STATUSES:
        return _LATENESS.AFTER_ACCEPTANCE
    if captured_at_device is None:
        return _LATENESS.UNKNOWN
    if window is None:
        raise deadlines_services.DeadlineKindNotConfiguredError(
            f"для категории {UPLOAD_WINDOW_KIND!r} нет строки в DeadlineKindConfig"
        )
    if received_at - captured_at_device <= window:
        return _LATENESS.ON_TIME
    return _LATENESS.LATE


# --- DeviceKey-манифест (ADR-053 п.2, ADR-136 п.6; включение — Э10) ---------


def verify_device_manifest(
    raw_manifest: Mapping[str, Any],
    signature: bytes,
    *,
    user: User,
    contract: Contract,
    content: bytes,
    milestone_id: UUID | None,
) -> tuple[manifest_module.DeviceManifest, DeviceKey, Any]:
    """Серверная половина офлайн-контура: разбор манифеста, ключ устройства
    ЭТОГО пользователя и не отозванный на момент съёмки, подпись над
    канонической формой, совпадение sha256 с ПОЛУЧЕННЫМИ байтами (телефон
    подписывает то, что снял; EXIF-очистка ADR-045 идёт после, `file_hash`
    — от очищенных байт, сырой хеш остаётся в подписанном манифесте),
    договор/этап манифеста = цель загрузки, назначение (если указано)
    действовало в момент съёмки (`apps.authority`). Возвращает разобранный
    манифест, ключ и назначение (или None)."""
    try:
        parsed = manifest_module.parse_device_manifest(raw_manifest)
    except manifest_module.DeviceManifestError as exc:
        raise DeviceManifestInvalidError(str(exc)) from exc

    if parsed.contract_id != contract.id:
        raise DeviceManifestInvalidError("манифест подписан для другого договора")
    if parsed.milestone_id != milestone_id:
        raise DeviceManifestInvalidError("манифест подписан для другого этапа")
    if parsed.sha256 != pipeline.compute_sha256(content):
        raise DeviceManifestInvalidError("sha256 манифеста не совпадает с полученным файлом")

    device_key = DeviceKey.objects.filter(pk=parsed.device_key_id, user=user).first()
    if device_key is None:
        raise DeviceManifestInvalidError("ключ устройства не найден у этого пользователя")
    if device_key.revoked_at is not None and device_key.revoked_at <= parsed.captured_at_device:
        raise DeviceManifestInvalidError("ключ устройства отозван до момента съёмки")
    if not manifest_module.verify_signature(
        public_key=bytes(device_key.public_key),
        algorithm=device_key.algorithm,
        message=manifest_module.canonical_manifest_bytes(raw_manifest),
        signature=signature,
    ):
        raise DeviceManifestInvalidError("подпись манифеста не сходится")

    assignment = None
    if parsed.assignment_id is not None:
        assignment = authority_selectors.get_assignment(parsed.assignment_id)
        if assignment is None or not authority_services.assignment_valid_at(
            assignment,
            user=user,
            contract_id=contract.id,
            milestone_id=milestone_id,
            at=parsed.captured_at_device,
        ):
            raise AssignmentNotValidError(
                f"назначение {parsed.assignment_id} не действовало в момент съёмки"
            )
    return parsed, device_key, assignment


# --- Загрузка ---------------------------------------------------------------


@transaction.atomic
def upload_evidence(
    contract: Contract,
    *,
    user: User,
    content: bytes,
    file_name: str,
    mime_type: str,
    description: str = "",
    milestone_id: UUID | None = None,
    checklist_item_id: UUID | None = None,
    dispute_id: UUID | None = None,
    object_store: EvidenceObjectStore | None = None,
    timestamp_provider: TimestampProvider = DEFAULT_TIMESTAMP_PROVIDER,
    device_manifest: Mapping[str, Any] | None = None,
    device_signature: bytes | None = None,
) -> Evidence:
    """`POST /evidence` (ГВ.3 п.1-2): приём файла -> пайплайн (хеш/
    миниатюра/метаданные, EXIF-очистка) -> релей контрагенту. Валидация
    привязки/членства в договоре — единообразно с остальными сервисами
    (apps.milestones/apps.disputes): проверяется здесь, не только в api/.

    Э6: оригинал уходит в бакет ШИФРОТЕКСТОМ (per-object DEK, субъект
    ("evidence", id)) — во ВСЕХ контурах (ADR-136 «Отмена части ГВ.3»,
    флаг контура оставлен ради обратимости); `lateness` — по ADR-053; манифест DeviceKey — только
    при `EVIDENCE_DEVICE_MANIFEST_ENABLED`; тот же хеш в другом договоре —
    событие `evidence.duplicate_hash` (сигнал, не запрет).

    `description` (решение владельца 05.09) — пояснение автора к файлу,
    метаданные МОМЕНТА СОЗДАНИЯ: изменить его потом нечем (PATCH на
    доказательство нет), поэтому обещание «неизменяемо» держится тем же
    способом, что и остальные поля строки."""
    if milestone_id is None and dispute_id is None:
        raise EvidenceNotAttachedError("evidence должно быть привязано к этапу или спору")
    if checklist_item_id is not None and milestone_id is not None:
        checklist_item = ChecklistItem.objects.get(pk=checklist_item_id)
        if checklist_item.milestone_id != milestone_id:
            raise ChecklistItemNotOnMilestoneError(
                f"пункт чек-листа {checklist_item_id} принадлежит другому этапу, не {milestone_id}"
            )
    contracts_services.get_party_for_user(contract, user)

    if len(content) > django_settings.EVIDENCE_MAX_FILE_SIZE_BYTES:
        raise EvidenceTooLargeError(
            f"файл {len(content)} байт превышает лимит "
            f"{django_settings.EVIDENCE_MAX_FILE_SIZE_BYTES}"
        )
    _check_rate_limit(user)

    parsed_manifest: manifest_module.DeviceManifest | None = None
    device_key: DeviceKey | None = None
    assignment: Any = None
    if device_manifest is not None:
        if not django_settings.EVIDENCE_DEVICE_MANIFEST_ENABLED:
            raise DeviceManifestDisabledError(
                "приём подписанных манифестов DeviceKey выключен (до Р1-мобайл, Э10)"
            )
        parsed_manifest, device_key, assignment = verify_device_manifest(
            device_manifest,
            device_signature or b"",
            user=user,
            contract=contract,
            content=content,
            milestone_id=milestone_id,
        )

    store = object_store if object_store is not None else build_evidence_object_store()
    result = pipeline.ingest(content, mime_type=mime_type)
    stamp = timestamp_provider.now()
    jurisdiction = resolve_jurisdiction(user.country_code)
    storage_mode = (
        _STORAGE_MODE.SERVER
        if jurisdiction.evidence_server_storage_enabled
        else _STORAGE_MODE.GLOBAL
    )
    milestone_status = (
        Milestone.objects.filter(pk=milestone_id).values_list("status", flat=True).first()
        if milestone_id is not None
        else None
    )
    captured_at = parsed_manifest.captured_at_device if parsed_manifest is not None else None
    lateness = compute_lateness(
        captured_at_device=captured_at,
        received_at=stamp.at,
        milestone_status=milestone_status,
        window=deadlines_selectors.get_kind_duration(UPLOAD_WINDOW_KIND),
    )

    metadata = dict(result.metadata)
    if parsed_manifest is not None:
        # Сырой хеш из подписанного манифеста — рядом с очищенным file_hash:
        # цепочка «подпись устройства -> сырой файл -> очищенная копия».
        metadata["manifest_sha256"] = parsed_manifest.sha256

    evidence = Evidence(
        contract=contract,
        milestone_id=milestone_id,
        checklist_item_id=checklist_item_id,
        dispute_id=dispute_id,
        uploaded_by=user,
        file_name=file_name,
        description=description,
        mime_type=mime_type,
        file_size=len(content),
        file_hash=result.sha256_hex,
        trusted_timestamp_at=stamp.at,
        trusted_timestamp_source=stamp.source,
        thumbnail=result.thumbnail,
        metadata=metadata,
        storage_mode=storage_mode,
        lateness=lateness,
        captured_at_device=captured_at,
        device_key=device_key,
        assignment=assignment,
        device_signature=device_signature if parsed_manifest is not None else None,
        device_clock_skew_ms=parsed_manifest.clock_skew_ms if parsed_manifest else None,
    )
    if parsed_manifest is not None and parsed_manifest.geo is not None:
        encrypted_geo = crypto.encrypt_bytes_for_subject(
            json.dumps(parsed_manifest.geo, sort_keys=True).encode("utf-8"),
            subject_type=GEO_SUBJECT_TYPE,
            subject_id=contract.id,
        )
        evidence.geo_encrypted = encrypted_geo.ciphertext
        evidence.geo_key_ref = encrypted_geo.key_ref

    if storage_mode in _SERVER_MODES:
        encrypted = crypto.encrypt_bytes_for_subject(
            result.relay_bytes, subject_type=EVIDENCE_SUBJECT_TYPE, subject_id=evidence.id
        )
        key = _s3_key(evidence.id, file_name)
        store.put(key, encrypted.ciphertext, content_type="application/octet-stream")
        evidence.s3_object_key = key
        evidence.encryption_key_ref = encrypted.key_ref
    else:
        evidence.transit_payload = result.relay_bytes
    evidence.save()

    outbox.publish(
        "evidence.received",
        subject={"type": "evidence", "id": str(evidence.id), "contract_id": str(contract.id)},
        payload=_self_sufficient_payload(
            evidence,
            file_hash=evidence.file_hash,
            lateness=evidence.lateness,
            strong_protection=is_strongly_protected(evidence),
        ),
        actor={"user_id": str(user.id)},
    )
    _signal_duplicate_hash(evidence, user=user)

    counterparty_user = contracts_selectors.party_user(
        contracts_selectors.resolve_counterparty(contract, user)
    )
    if counterparty_user is not None:
        notifications_services.place_notification(
            recipient=counterparty_user,
            template="evidence_received",
            payload={"evidence_id": str(evidence.id), "file_name": file_name},
            legal_significance=True,
        )
    return evidence


def _signal_duplicate_hash(evidence: Evidence, *, user: User) -> None:
    """tech-spec.md §5.2.8 «INDEX (original_sha256) — дедуп/анти-фрод»: тот
    же файл уже фигурирует в ДРУГОМ договоре — событие (в Audit Vault и
    будущим анти-фрод-подписчикам), не запрет: один и тот же снимок в двух
    сделках может быть и честным (сравнение «до/после»), вес — людям."""
    duplicates = list(
        Evidence.objects.filter(file_hash=evidence.file_hash)
        .exclude(contract_id=evidence.contract_id)
        .values_list("id", "contract_id")
    )
    if not duplicates:
        return
    evidence.metadata["duplicate_hash"] = True
    evidence.save(update_fields=["metadata"])
    outbox.publish(
        "evidence.duplicate_hash",
        subject={
            "type": "evidence",
            "id": str(evidence.id),
            "contract_id": str(evidence.contract_id),
        },
        payload=_self_sufficient_payload(
            evidence,
            file_hash=evidence.file_hash,
            duplicate_evidence_ids=[str(eid) for eid, _ in duplicates],
            duplicate_contract_count=len({cid for _, cid in duplicates}),
        ),
        actor={"user_id": str(user.id)},
    )


# --- Чтение оригинала --------------------------------------------------------


def read_original_bytes(evidence: Evidence, *, object_store: EvidenceObjectStore) -> bytes:
    """Открытые байты оригинала из бакета: расшифровка конверта, если объект
    уже зашифрован (`encryption_key_ref`), иначе — как лежит (объект до
    backfill). Уничтоженный ключ — `EvidenceOriginalShreddedError`."""
    if evidence.retention_state == _RETENTION.SHREDDED:
        raise EvidenceOriginalShreddedError(
            f"оригинал доказательства {evidence.id} уничтожен по сроку хранения"
        )
    body = object_store.get(evidence.s3_object_key)
    if not evidence.encryption_key_ref:
        return body
    try:
        return crypto.decrypt_bytes_for_subject(body, evidence.encryption_key_ref)
    except crypto.SubjectKeyDestroyedError as exc:
        raise EvidenceOriginalShreddedError(
            f"ключ оригинала доказательства {evidence.id} уничтожен"
        ) from exc


@transaction.atomic
def download_original(
    evidence: Evidence, *, user: User, object_store: EvidenceObjectStore | None = None
) -> bytes:
    """Скачивание (ГВ.3 п.1). Серверное хранение: оригинал в бакете,
    доступен до уничтожения ключа по сроку хранения (ADR-036; `archived` —
    только состояние, физического холодного тира нет, скачивание работает).
    GLOBAL: доступен из `transit_payload`, ПОКА не удалён; первое скачивание
    СТОРОНОЙ, ОТЛИЧНОЙ ОТ загрузившего, фиксирует доставку и запускает
    удаление оригинала."""
    contracts_services.get_party_for_user(evidence.contract, user)
    if evidence.retention_state == _RETENTION.SHREDDED:
        raise EvidenceOriginalShreddedError(
            f"оригинал доказательства {evidence.id} уничтожен по сроку хранения"
        )

    if evidence.storage_mode in _SERVER_MODES:
        store = object_store if object_store is not None else build_evidence_object_store()
        content = read_original_bytes(evidence, object_store=store)
    else:
        if evidence.transit_payload is None:
            raise EvidenceOriginalUnavailableError(
                f"оригинал доказательства {evidence.id} уже удалён после доставки"
            )
        content = bytes(evidence.transit_payload)

    if (
        user.id != evidence.uploaded_by_id
        and evidence.delivery_status == _DELIVERY_STATUS.IN_TRANSIT
    ):
        now = timezone.now()
        evidence.delivered_to_counterparty_at = now
        evidence.delivery_status = _DELIVERY_STATUS.DELIVERED
        update_fields = ["delivered_to_counterparty_at", "delivery_status"]
        if evidence.storage_mode == _STORAGE_MODE.GLOBAL:
            evidence.transit_payload = None
            update_fields.append("transit_payload")
        evidence.save(update_fields=update_fields)

        outbox.publish(
            "evidence.received",
            subject={
                "type": "evidence",
                "id": str(evidence.id),
                "contract_id": str(evidence.contract_id),
            },
            payload=_self_sufficient_payload(evidence, delivered=True),
            actor={"user_id": str(user.id)},
        )
        if evidence.storage_mode == _STORAGE_MODE.GLOBAL:
            outbox.publish(
                "evidence.originals_deleted",
                subject={
                    "type": "evidence",
                    "id": str(evidence.id),
                    "contract_id": str(evidence.contract_id),
                },
                payload=_self_sufficient_payload(evidence),
                actor={},
            )
    return content


def verify_hash(evidence: Evidence, *, presented_content: bytes, user: User) -> bool:
    """`POST /evidence/{id}/verify` (ГВ.3 п.2: «эндпоинт сверить
    предъявленный файл с хешом»). Хеш в модели — от ОЧИЩЕННЫХ байт
    (services/evidence_ingest/pipeline.ingest), поэтому сравнение
    осмысленно ровно против того, что реально было в релее. Работает и
    после уничтожения оригинала — в этом смысл «хеши бессрочно» (ADR-036)."""
    contracts_services.get_party_for_user(evidence.contract, user)
    return pipeline.compute_sha256(presented_content) == evidence.file_hash


@transaction.atomic
def request_backup(
    evidence: Evidence,
    *,
    user: User,
    provider: GoogleDriveBackupProvider,
    object_store: EvidenceObjectStore | None = None,
) -> Evidence:
    """`POST /evidence/{id}/backup` (ГВ.3 п.3): BYO-бэкап в Google Drive
    ТЕМ ЖЕ аккаунтом, что вход (ГВ.2, `SocialLoginAccount`). Отказ провайдера
    НЕ поднимает исключение выше — «отказ ничего не блокирует, честное
    предупреждение о риске утраты оригиналов» (ГВ.3 п.3): статус
    `failed` + причина видны на самой модели, вызывающая сторона решает,
    что показать пользователю. Это ЕДИНООБРАЗНО распространяется и на
    ошибки RealGoogleDriveBackupProvider «грант не подключён/отозван»
    (docs/tasks/Задача_feat_evidence-drive.md §2.3) — тот же
    GoogleDriveBackupError, тот же путь деградации, `backup_failure_reason`
    доносит причину до клиента.

    Идемпотентность (§2.3): уже COMPLETED с сохранённым file id — повторный
    вызов НЕ шлёт файл в Drive ещё раз, просто возвращает текущее состояние."""
    contracts_services.get_party_for_user(evidence.contract, user)

    if evidence.backup_status == _BACKUP_STATUS.COMPLETED and evidence.backup_drive_file_id:
        return evidence

    social_account = SocialLoginAccount.objects.filter(user=user, provider="google").first()
    if social_account is None:
        evidence.backup_status = _BACKUP_STATUS.FAILED
        evidence.backup_failure_reason = "к аккаунту не привязан Google (нужен для Drive-бэкапа)"
        evidence.save(update_fields=["backup_status", "backup_failure_reason"])
        return evidence

    if evidence.retention_state == _RETENTION.SHREDDED:
        evidence.backup_status = _BACKUP_STATUS.FAILED
        evidence.backup_failure_reason = "оригинал уничтожен по сроку хранения — бэкапить нечего"
        evidence.save(update_fields=["backup_status", "backup_failure_reason"])
        return evidence

    if evidence.storage_mode == _STORAGE_MODE.GLOBAL and evidence.transit_payload is None:
        evidence.backup_status = _BACKUP_STATUS.FAILED
        evidence.backup_failure_reason = "оригинал уже удалён после доставки — бэкапить нечего"
        evidence.save(update_fields=["backup_status", "backup_failure_reason"])
        return evidence

    evidence.backup_status = _BACKUP_STATUS.PENDING
    evidence.backup_provider = provider.provider_code
    evidence.save(update_fields=["backup_status", "backup_provider"])

    if evidence.storage_mode == _STORAGE_MODE.GLOBAL:
        # Непустой transit_payload уже проверен выше (иначе ранний return).
        assert evidence.transit_payload is not None
        content = bytes(evidence.transit_payload)
    else:
        store = object_store if object_store is not None else build_evidence_object_store()
        content = read_original_bytes(evidence, object_store=store)
    try:
        result = provider.upload(
            account_sub=social_account.sub,
            file_name=evidence.file_name,
            content=content,
            mime_type=evidence.mime_type,
        )
    except GoogleDriveBackupError as exc:
        evidence.backup_status = _BACKUP_STATUS.FAILED
        evidence.backup_failure_reason = str(exc)
        evidence.save(update_fields=["backup_status", "backup_failure_reason"])
        return evidence

    evidence.backup_status = _BACKUP_STATUS.COMPLETED
    evidence.backup_completed_at = timezone.now()
    evidence.backup_failure_reason = ""
    evidence.backup_drive_file_id = result.file_id
    evidence.backup_drive_web_view_link = result.web_view_link
    evidence.save(
        update_fields=[
            "backup_status",
            "backup_completed_at",
            "backup_failure_reason",
            "backup_drive_file_id",
            "backup_drive_web_view_link",
        ]
    )
    return evidence


# --- Перешифрование объектов до ADR-136 (management-команда) ----------------


@transaction.atomic
def encrypt_legacy_original(
    evidence: Evidence, *, object_store: EvidenceObjectStore, delete_plaintext: bool = False
) -> bool:
    """Один шаг `evidence_encrypt_backfill`: открытый объект -> шифротекст под
    НОВЫМ ключом (под WORM перезаписать нельзя), `encryption_key_ref`
    проставлен. Идемпотентно: уже зашифрованный / уничтоженный / GLOBAL —
    False. Перед записью сверяется хеш прочитанного с `file_hash` — если не
    сошёлся, объект не трогаем (warning): доказательство важнее прогресса
    команды."""
    if (
        evidence.storage_mode not in _SERVER_MODES
        or not evidence.s3_object_key
        or evidence.encryption_key_ref
        or evidence.retention_state == _RETENTION.SHREDDED
    ):
        return False
    plaintext = object_store.get(evidence.s3_object_key)
    if pipeline.compute_sha256(plaintext) != evidence.file_hash:
        logger.warning(
            "evidence_encrypt_backfill: хеш объекта %s не совпал с file_hash — пропуск",
            evidence.id,
        )
        return False
    encrypted = crypto.encrypt_bytes_for_subject(
        plaintext, subject_type=EVIDENCE_SUBJECT_TYPE, subject_id=evidence.id
    )
    old_key = evidence.s3_object_key
    new_key = _s3_key_encrypted(evidence.id, evidence.file_name)
    object_store.put(new_key, encrypted.ciphertext, content_type="application/octet-stream")
    evidence.s3_object_key = new_key
    evidence.encryption_key_ref = encrypted.key_ref
    evidence.save(update_fields=["s3_object_key", "encryption_key_ref"])
    if delete_plaintext:
        object_store.delete(old_key)
    return True


# --- RetentionTimer (ADR-036 / ADR-137) -------------------------------------


def _duration(kind: str) -> timedelta:
    duration = deadlines_selectors.get_kind_duration(kind)
    if duration is None:
        raise deadlines_services.DeadlineKindNotConfiguredError(
            f"для категории {kind!r} нет строки в DeadlineKindConfig"
        )
    return duration


def _create_retention_deadline(
    contract: Contract, *, kind: str, anchor_at: datetime, deadline_at: datetime | None = None
) -> DomainDeadline:
    return deadlines_services.create_deadline(
        kind=kind,
        subject_type="contract",
        subject_id=contract.id,
        starts_from=DomainDeadline.StartsFrom.EVENT,
        anchor_at=anchor_at,
        deadline_at=deadline_at,
    )


def _timer_deadlines(timer: RetentionTimer) -> dict[str, DomainDeadline]:
    """Живые строки дедлайнов таймера по категории (отсутствующие —
    пропущены: строка хранится по значению, без FK)."""
    found: dict[str, DomainDeadline] = {}
    for kind, deadline_id in (
        (HOT_RETENTION_KIND, timer.hot_deadline_id),
        (ARCHIVE_RETENTION_KIND, timer.archive_deadline_id),
        (RETENTION_NOTICE_KIND, timer.notice_deadline_id),
    ):
        deadline = deadlines_selectors.get_deadline(deadline_id)
        if deadline is not None:
            found[kind] = deadline
    return found


def _deadline_at(deadline_id: UUID) -> str | None:
    deadline = deadlines_selectors.get_deadline(deadline_id)
    if deadline is None or deadline.deadline_at is None:
        return None
    return deadline.deadline_at.isoformat()


@transaction.atomic
def start_retention_timer(contract: Contract, *, anchored_at: datetime) -> RetentionTimer:
    """Окончание сделки (`contract.completed` / `contract.terminated`;
    `contract.closed` — фолбэк) -> три дедлайна `starts_from=event` от
    `anchored_at`: горячее (90 дн) -> архив; архив (1 год) -> уничтожение
    ключей; уведомление «скачайте себе» = архив − 10 дн (производный
    дедлайн, явный `deadline_at`). Идемпотентно: таймер на договор один
    (OneToOne), повторная доставка события — NOOP. Если на момент старта по
    договору уже есть открытое разногласие — таймер сразу на паузе (иначе
    спор, открытый ДО расторжения, паузу бы не получил)."""
    existing = RetentionTimer.objects.filter(contract=contract).first()
    if existing is not None:
        return existing
    hot = _create_retention_deadline(contract, kind=HOT_RETENTION_KIND, anchor_at=anchored_at)
    archive = _create_retention_deadline(
        contract, kind=ARCHIVE_RETENTION_KIND, anchor_at=anchored_at
    )
    assert archive.deadline_at is not None
    notice = _create_retention_deadline(
        contract,
        kind=RETENTION_NOTICE_KIND,
        anchor_at=anchored_at,
        deadline_at=archive.deadline_at - _duration(RETENTION_NOTICE_KIND),
    )
    timer = RetentionTimer.objects.create(
        contract=contract,
        anchored_at=anchored_at,
        hot_deadline_id=hot.id,
        archive_deadline_id=archive.id,
        notice_deadline_id=notice.id,
    )
    _publish_contract_event(
        "evidence.retention_started",
        contract,
        retention_timer_id=str(timer.id),
        anchored_at=anchored_at.isoformat(),
        hot_until=_deadline_at(timer.hot_deadline_id),
        archive_until=_deadline_at(timer.archive_deadline_id),
    )
    if disputes_selectors.has_open_disputes(contract.id):
        pause_retention_timer(timer, reason="dispute_open_at_start")
    return timer


@transaction.atomic
def pause_retention_timer(timer: RetentionTimer, *, reason: str) -> RetentionTimer:
    """`dispute.opened` -> пауза всех дедлайнов (ADR-036: «иначе сторону
    можно дотянуть до уничтожения улик»). Идемпотентно."""
    if timer.paused_at is not None or timer.state == _TIMER_STATE.SHREDDED:
        return timer
    for deadline in _timer_deadlines(timer).values():
        if deadline.fired_at is None and not deadline.paused:
            deadlines_services.pause_deadline(deadline, reason=reason)
    timer.paused_at = timezone.now()
    timer.pause_reason = reason
    timer.save(update_fields=["paused_at", "pause_reason"])
    return timer


def effective_deadline_at(
    timer: RetentionTimer, *, kind: str, paused_total: timedelta, resumed_at: datetime
) -> datetime:
    """ADR-137 требование 4 — предел продления как ПРОВЕРКА: срок
    продлевается на суммарную паузу, но не дальше `resumed_at + cap` (6 мес
    после завершения спора), и никогда не раньше базового срока оферты
    (`anchored_at + duration`). Уведомление — всегда `archive − notice`."""
    if kind == RETENTION_NOTICE_KIND:
        archive_at = effective_deadline_at(
            timer, kind=ARCHIVE_RETENTION_KIND, paused_total=paused_total, resumed_at=resumed_at
        )
        return archive_at - _duration(RETENTION_NOTICE_KIND)
    base = timer.anchored_at + _duration(kind)
    extended = base + paused_total
    capped = min(extended, resumed_at + _duration(DISPUTE_PAUSE_CAP_KIND))
    return max(base, capped)


@transaction.atomic
def resume_retention_timer(timer: RetentionTimer) -> RetentionTimer:
    """`dispute.resolved` без других открытых споров -> продление дедлайнов
    на длительность паузы (срок хранения ПРОДЛЕВАЕТСЯ на время спора, а не
    «дотикивает» остаток) с жёстким пределом ADR-137 (`effective_deadline_at`)
    + возобновление. Идемпотентно."""
    if timer.paused_at is None:
        return timer
    now = timezone.now()
    paused_total = timer.paused_total + (now - timer.paused_at)
    for kind, deadline in _timer_deadlines(timer).items():
        if deadline.fired_at is not None or deadline.deadline_at is None:
            continue
        target = effective_deadline_at(timer, kind=kind, paused_total=paused_total, resumed_at=now)
        deadlines_services.shift_deadline(deadline, by=target - deadline.deadline_at)
        if deadline.paused:
            deadlines_services.resume_deadline(deadline)
    timer.paused_total = paused_total
    timer.paused_at = None
    timer.pause_reason = ""
    timer.save(update_fields=["paused_total", "paused_at", "pause_reason"])
    return timer


@transaction.atomic
def notify_retention_expiring(timer: RetentionTimer) -> None:
    """За 10 дней до уничтожения (дедлайн `evidence_retention_notice`) —
    событие обеим сторонам «скачайте себе» (реестр
    NOTIFICATION_TOPIC_COUNTERPARTY_TEMPLATES, actor пуст; формулировка
    обещания — ADR-137). На уже уничтоженном — NOOP."""
    if timer.state == _TIMER_STATE.SHREDDED:
        return
    _publish_contract_event(
        "evidence.retention_expiring",
        timer.contract,
        retention_timer_id=str(timer.id),
        expires_at=_deadline_at(timer.archive_deadline_id),
        notice_days=_duration(RETENTION_NOTICE_KIND).days,
    )


@transaction.atomic
def archive_contract_evidence(timer: RetentionTimer) -> int:
    """`evidence_hot_retention` сработал: горячее -> архив. В этой волне
    архив — ТОЛЬКО состояние строки + событие (физического «ледяного» тира
    нет, скачивание работает как прежде; ADR-136). Идемпотентно по
    `timer.state`."""
    if timer.state != _TIMER_STATE.HOT:
        return 0
    now = timezone.now()
    count = Evidence.objects.filter(
        contract_id=timer.contract_id, retention_state=_RETENTION.HOT
    ).update(retention_state=_RETENTION.ARCHIVED, archived_at=now)
    timer.state = _TIMER_STATE.ARCHIVED
    timer.archived_at = now
    timer.save(update_fields=["state", "archived_at"])
    _publish_contract_event(
        "evidence.archived",
        timer.contract,
        retention_timer_id=str(timer.id),
        evidence_count=count,
        archive_until=_deadline_at(timer.archive_deadline_id),
    )
    return count


@transaction.atomic
def shred_contract_evidence(timer: RetentionTimer) -> int:
    """`evidence_archive_retention` сработал: crypto-shredding оригиналов —
    уничтожение KEK конверта каждого файла (`common.crypto.
    destroy_subject_key`), `s3_object_key` и транзитная копия обнуляются,
    объект в WORM-бакете остаётся нечитаемым шифротекстом. Строка, хеш,
    `tsa_token`, миниатюра, метаданные — остаются навсегда (ADR-036/137:
    «хеши, .tsr, цепочки — не удалять никогда», включая удаление по запросу
    пользователя). Аудит фактического удаления (ADR-137 требование 7):
    событие `evidence.shredded` со списком id (Audit Vault подписан на все
    топики) + строка лога на каждый файл. Идемпотентно по `timer.state`."""
    if timer.state == _TIMER_STATE.SHREDDED:
        return 0
    now = timezone.now()
    shredded_ids: list[str] = []
    for evidence in Evidence.objects.filter(contract_id=timer.contract_id).exclude(
        retention_state=_RETENTION.SHREDDED
    ):
        if evidence.encryption_key_ref:
            crypto.destroy_subject_key(EVIDENCE_SUBJECT_TYPE, evidence.id)
        evidence.s3_object_key = ""
        evidence.transit_payload = None
        evidence.retention_state = _RETENTION.SHREDDED
        if evidence.archived_at is None:
            evidence.archived_at = now
        evidence.shredded_at = now
        evidence.save(
            update_fields=[
                "s3_object_key",
                "transit_payload",
                "retention_state",
                "archived_at",
                "shredded_at",
            ]
        )
        shredded_ids.append(str(evidence.id))
        logger.info(
            "evidence retention: оригинал %s договора %s уничтожен (ключ конверта %s), "
            "хеш %s сохранён",
            evidence.id,
            timer.contract_id,
            evidence.encryption_key_ref or "-",
            evidence.file_hash,
        )
    timer.state = _TIMER_STATE.SHREDDED
    if timer.archived_at is None:
        timer.archived_at = now
    timer.shredded_at = now
    timer.save(update_fields=["state", "archived_at", "shredded_at"])
    _publish_contract_event(
        "evidence.shredded",
        timer.contract,
        retention_timer_id=str(timer.id),
        evidence_count=len(shredded_ids),
        evidence_ids=shredded_ids,
    )
    return len(shredded_ids)
