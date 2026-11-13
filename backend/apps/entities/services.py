"""Use cases apps.entities (tech-spec.md §7.2, §8.2; domain-model.md §3.2.1,
§3.2.2, §5; ADR-042, ADR-063).

Список операций, защищённых `assert_entity_operable()` (ADR-042: «список
закрыт и покрыт тестами»): `update_business_entity()` (3.4) и
`apps.authority.services.grant_representative`/`grant_signing_authority`
(3.5, apps.authority импортирует этот гейт напрямую). Договоры/репутация/
поиск из domain-model.md §3.2.2 появятся в следующих этапах и будут
вызывать тот же гейт из своих сервисов.

`director_full_name_matches()` — публичный facade для apps.authority
(REGISTRY_VERIFIED_DIRECTOR — то же сравнение ФИО, что уже использует
`try_auto_claim()` для DIRECTOR_IDENTITY_MATCH claim'а, не дублируем логику).
"""

from __future__ import annotations

import hashlib
from typing import Any

from django.db import transaction
from django.utils import timezone

from apps.accounts import services as accounts_services
from apps.accounts.models import User
from apps.identity import selectors as identity_selectors
from common import outbox
from common.crypto import encrypt_for_subject

from .models import BusinessEntity, OwnershipEpoch, TaxIdentifier
from .providers import EntityRegistryProvider

_INN = TaxIdentifier.IdType.INN


class EntityNotFoundInRegistryError(ValueError):
    """Идентификатор не найден в реестре (провайдер вернул `found=False`)."""


class EntityLiquidatedError(ValueError):
    """Компания ликвидирована/недействующая по данным реестра."""


class EntityNotOperableError(ValueError):
    """Гейт ADR-042: карточка без подтверждённого контроля существует, но
    инертна для операций из закрытого списка."""


class EntityPermissionDeniedError(ValueError):
    """Операция доступна только пользователю, подтвердившему контроль."""


class ClaimMethodNotAvailableError(ValueError):
    """Способ подтверждения контроля — валидное значение enum, но флоу для
    него в Р1 не реализован (etap-3.md 3.4)."""


class ClaimMethodNotSatisfiedError(ValueError):
    """Автоматический способ (director/owner identity match) не подтвердился
    для вызывающего пользователя."""


def _hash_tax_id(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _director_identity_hash(director_full_name: str) -> str:
    if not director_full_name:
        return ""
    normalized = director_full_name.strip().casefold()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _names_match(a: str, b: str) -> bool:
    return bool(a) and bool(b) and a.strip().casefold() == b.strip().casefold()


def _verified_full_name(user: User) -> str | None:
    verification = identity_selectors.get_latest_verification(user)
    if verification is None:
        return None
    return identity_selectors.get_verified_full_name(verification)


def director_full_name_matches(entity: BusinessEntity, user: User) -> bool:
    """Facade для apps.authority (SigningBasis.REGISTRY_VERIFIED_DIRECTOR):
    ФИО верифицированного пользователя совпадает с директором по реестру."""
    verified_full_name = _verified_full_name(user)
    if verified_full_name is None:
        return False
    return _names_match(verified_full_name, entity.director_full_name)


@transaction.atomic
def register_business_entity(
    tax_id: str, *, country: str, created_by: User, provider: EntityRegistryProvider
) -> BusinessEntity:
    """POST /business-entities. Онбординг по одному идентификатору
    (domain-model.md §3.2.1) — TaxIdentifier.UNIQUE(id_type, value) делает
    повторный онбординг того же ИНН идемпотентным (возвращает существующую
    карточку вместо дубликата или IntegrityError)."""
    existing = (
        TaxIdentifier.objects.filter(id_type=_INN, value=tax_id).select_related("entity").first()
    )
    if existing is not None:
        entity = existing.entity
        if entity.claim_status == BusinessEntity.ClaimStatus.UNCLAIMED:
            try_auto_claim(entity, created_by)
        return entity

    data = provider.fetch_entity_data(tax_id)
    if not data.found:
        raise EntityNotFoundInRegistryError(
            f"компания с идентификатором {tax_id!r} не найдена в реестре"
        )
    if not data.is_active_in_registry:
        raise EntityLiquidatedError("компания ликвидирована или недействующая по данным реестра")

    now = timezone.now()
    entity = BusinessEntity.objects.create(
        country_of_registration=country,
        local_form_code=data.local_form_code,
        name=data.name,
        short_name=data.short_name,
        registered_address=data.registered_address,
        verification_status=BusinessEntity.VerificationStatus.VERIFIED,
        verified_against_registry=True,
        verified_at=now,
        claim_status=BusinessEntity.ClaimStatus.UNCLAIMED,
        director_full_name=data.director_full_name,
        director_position_label=data.director_position_label,
        director_since=data.director_since,
        director_source="registry",
        created_by=created_by,
    )
    for tax_identifier in data.tax_identifiers:
        TaxIdentifier.objects.create(
            entity=entity, id_type=tax_identifier.id_type, value=tax_identifier.value
        )

    OwnershipEpoch.objects.create(
        entity=entity,
        epoch_number=1,
        director_identity_hash=_director_identity_hash(data.director_full_name),
        started_at=now,
        detected_via=OwnershipEpoch.DetectedVia.INITIAL_VERIFICATION,
    )

    try_auto_claim(entity, created_by)
    return entity


def _apply_claim(entity: BusinessEntity, user: User, method: str) -> None:
    entity.claim_status = BusinessEntity.ClaimStatus.CLAIMED
    entity.claimed_by = user
    entity.claim_method = method
    entity.claimed_at = timezone.now()
    entity.save(update_fields=["claim_status", "claimed_by", "claim_method", "claimed_at"])
    outbox.publish(
        "entity.claimed",
        subject={"type": "business_entity", "id": str(entity.id)},
        # ADR-178: settings.NOTIFICATION_TOPIC_ADDRESSEE_TEMPLATES адресует
        # ТОЛЬКО по явному notify_user_id (без фолбэка на actor.user_id) —
        # кладём его явно, хотя получатель тут и есть сам actor: карточка
        # claim'а служит юридической квитанцией и якорем проверочного
        # дедлайна (apps.notifications.tests.test_subscriber), а не
        # напоминанием о собственном действии.
        payload={"method": method, "notify_user_id": str(user.id)},
        actor={"user_id": str(user.id)},
    )


@transaction.atomic
def try_auto_claim(entity: BusinessEntity, user: User) -> bool:
    """domain-model.md §3.2.2: автоматическое подтверждение контроля —
    ИП/самозанятые по ИНН (владелец), директор по ФИО. Тихо возвращает
    False, если условия не выполнены (не исключение — вызывается как
    попытка при каждом онбординге/входе, а не как явное действие
    пользователя)."""
    if entity.claim_status == BusinessEntity.ClaimStatus.CLAIMED:
        return False
    if user.verification_level not in (
        User.VerificationLevel.VERIFIED,
        User.VerificationLevel.BUSINESS,
    ):
        return False

    if entity.local_form_code in BusinessEntity.OWNER_CLAIMABLE_FORMS and user.personal_tax_id_hash:
        inn = entity.tax_identifiers.filter(id_type=_INN).first()
        if inn is not None and _hash_tax_id(inn.value) == user.personal_tax_id_hash:
            _apply_claim(entity, user, BusinessEntity.ClaimMethod.OWNER_IDENTITY_MATCH)
            # Р1 (деньги, обязательный тест): подтверждён СОБСТВЕННЫЙ
            # ИП/СМЗ -> у человека появляется бизнес-статус.
            accounts_services.set_business_status(user, True)
            return True

    if entity.director_full_name:
        verified_full_name = _verified_full_name(user)
        if verified_full_name and _names_match(verified_full_name, entity.director_full_name):
            _apply_claim(entity, user, BusinessEntity.ClaimMethod.DIRECTOR_IDENTITY_MATCH)
            entity.director_user = user
            entity.save(update_fields=["director_user"])
            # ВНИМАНИЕ (Р1, обязательный тест): директорство ЧУЖОГО юрлица
            # бизнес-статуса ФИЗЛИЦУ не даёт — has_business_status НЕ трогаем.
            return True

    return False


@transaction.atomic
def claim_business_entity(
    entity: BusinessEntity, user: User, *, method: str, proof: dict[str, Any]
) -> BusinessEntity:
    """POST /business-entities/{id}/claim. `proof` пока используется только
    для MANUAL_REVIEW (без UI оператора — заявка остаётся в статусе pending,
    очередь для backoffice — вне 3.4)."""
    if method in (
        BusinessEntity.ClaimMethod.DIRECTOR_IDENTITY_MATCH,
        BusinessEntity.ClaimMethod.OWNER_IDENTITY_MATCH,
    ):
        if not try_auto_claim(entity, user):
            raise ClaimMethodNotSatisfiedError(
                f"условия способа {method!r} не выполнены для этого пользователя"
            )
        entity.refresh_from_db()
        return entity

    if method == BusinessEntity.ClaimMethod.MANUAL_REVIEW:
        entity.claim_status = BusinessEntity.ClaimStatus.PENDING
        entity.claim_method = BusinessEntity.ClaimMethod.MANUAL_REVIEW
        entity.save(update_fields=["claim_status", "claim_method"])
        return entity

    raise ClaimMethodNotAvailableError(f"способ {method!r} пока не реализован (Р1)")


@transaction.atomic
def dispute_claim(
    entity: BusinessEntity, claimant: User, *, proof: dict[str, Any] | None = None
) -> BusinessEntity:
    """POST /business-entities/{id}/claim/dispute (ADR-042): возврат
    захваченной карточки — директор по реестру ВСЕГДА побеждает. Отзыв
    полномочий захватчика (domain-model.md §3.2.2: revoke_all_authorities) —
    apps.authority.services.revoke_all_signing_authorities, отложенный
    импорт (apps.authority.services сам импортирует apps.entities.services
    напрямую — обычный import на верхнем уровне создал бы цикл)."""
    entity.claim_status = BusinessEntity.ClaimStatus.DISPUTED
    entity.save(update_fields=["claim_status"])

    verified_full_name = _verified_full_name(claimant)
    if (
        entity.director_full_name
        and verified_full_name
        and _names_match(verified_full_name, entity.director_full_name)
    ):
        from apps.authority import services as authority_services

        authority_services.revoke_all_signing_authorities(entity, reason="claim_disputed")
        _apply_claim(entity, claimant, BusinessEntity.ClaimMethod.DIRECTOR_IDENTITY_MATCH)
        entity.director_user = claimant
        entity.save(update_fields=["director_user"])
        return entity

    outbox.publish(
        "entity.claim_disputed",
        subject={"type": "business_entity", "id": str(entity.id)},
        payload={"proof": proof or {}},
        actor={"user_id": str(claimant.id)},
    )
    return entity


def assert_entity_operable(entity: BusinessEntity) -> None:
    """ADR-042: карточка без подтверждённого контроля существует, но
    ИНЕРТНА — недоступны договоры, выдача полномочий, портфолио, репутация,
    показ в поиске."""
    if entity.claim_status != BusinessEntity.ClaimStatus.CLAIMED:
        raise EntityNotOperableError("контроль над юрлицом не подтверждён — операция недоступна")


@transaction.atomic
def update_business_entity(
    entity: BusinessEntity,
    user: User,
    *,
    tax_regime_code: str | None = None,
    bank_details: dict[str, Any] | None = None,
) -> BusinessEntity:
    """PATCH /business-entities/{id}: ручные поля (налоговый режим,
    банковские реквизиты). Единственная операция 3.4, защищённая
    `assert_entity_operable()`."""
    assert_entity_operable(entity)
    if entity.claimed_by_id != user.id:
        raise EntityPermissionDeniedError(
            "редактировать карточку может только подтвердивший контроль пользователь"
        )

    update_fields = []
    if tax_regime_code is not None:
        entity.tax_regime_code = tax_regime_code
        update_fields.append("tax_regime_code")
    if bank_details is not None:
        encrypted = encrypt_for_subject(
            str(bank_details), subject_type="business_entity", subject_id=entity.id
        )
        entity.bank_details_encrypted = encrypted.ciphertext
        entity.encryption_key_ref = encrypted.key_ref
        update_fields += ["bank_details_encrypted", "encryption_key_ref"]
    if update_fields:
        entity.save(update_fields=update_fields)
    return entity


@transaction.atomic
def reconcile_ownership_epoch(
    entity: BusinessEntity, *, provider: EntityRegistryProvider
) -> OwnershipEpoch | None:
    """Плановая фоновая сверка директора (domain-model.md §5,
    scheduled_registry_check) — вызывается из apps.entities.tasks по
    расписанию Celery beat. Возвращает новую эпоху, только если контроль
    реально сменился (сравнение хешей ФИО директора)."""
    tax_identifier = entity.tax_identifiers.filter(id_type=_INN).first()
    if tax_identifier is None:
        return None

    data = provider.fetch_entity_data(tax_identifier.value)
    if not data.found:
        return None

    current_hash = _director_identity_hash(data.director_full_name)
    active_epoch = (
        entity.ownership_epochs.filter(ended_at__isnull=True).order_by("-epoch_number").first()
    )
    if active_epoch is None or active_epoch.director_identity_hash == current_hash:
        return None

    now = timezone.now()
    active_epoch.ended_at = now
    active_epoch.save(update_fields=["ended_at"])

    new_epoch = OwnershipEpoch.objects.create(
        entity=entity,
        epoch_number=active_epoch.epoch_number + 1,
        director_identity_hash=current_hash,
        started_at=now,
        detected_via=OwnershipEpoch.DetectedVia.SCHEDULED_REGISTRY_CHECK,
    )

    if entity.director_full_name != data.director_full_name:
        entity.director_full_name = data.director_full_name
        entity.director_position_label = data.director_position_label
        entity.director_source = "registry"
        entity.director_user = None
        entity.save(
            update_fields=[
                "director_full_name",
                "director_position_label",
                "director_source",
                "director_user",
            ]
        )

    outbox.publish(
        "entity.epoch_changed",
        subject={"type": "business_entity", "id": str(entity.id)},
        payload={"epoch_number": new_epoch.epoch_number},
        actor={},
    )
    return new_epoch
