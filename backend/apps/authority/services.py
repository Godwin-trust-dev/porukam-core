"""Use cases apps.authority (tech-spec.md §7.2, §8.2; domain-model.md §4;
docs/tasks/etap-3.md 3.5; ADR-004 внешнего журнала).

Гейт `apps.entities.services.assert_entity_operable()` (ADR-042) закрывает
выдачу представительства/права подписи здесь же, как и обещано в докстринге
apps/entities/services.py (список операций закрыт и покрыт тестами)."""

from __future__ import annotations

from typing import Any

from django.db import transaction
from django.utils import timezone

from apps.accounts.models import User
from apps.entities import services as entities_services
from apps.entities.models import BusinessEntity
from common import outbox
from common.money import Money

from . import selectors
from .models import ContractAssignment, Representative, SigningAuthority
from .providers import DEFAULT_POA_PROVIDER, PoaRegistryProvider


class RepresentativePermissionDeniedError(ValueError):
    """Действие над представителями доступен только тем, у кого есть
    permission MANAGE_REPRESENTATIVES (domain-model.md §4)."""


class ManualReviewNotAllowedForSeparatedOwnershipError(ValueError):
    """ADR-004: для форм с разделёнными ролями владельца/исполнителя (ООО и
    аналоги) ручная экспертиза как основание права подписи запрещена."""


class DirectorMismatchError(ValueError):
    """SigningBasis.REGISTRY_VERIFIED_DIRECTOR: ФИО заявителя не совпадает с
    директором по реестру."""


class SigningAuthorityNotFoundError(ValueError):
    """Право подписи не принадлежит указанному юрлицу (или не существует)."""


def _apply_role_preset(role: str) -> list[str]:
    return list(Representative.ROLE_PRESETS.get(role, ()))


@transaction.atomic
def grant_representative(
    entity: BusinessEntity,
    granter: User,
    target_user: User,
    *,
    role: str,
    permissions: list[str] | None = None,
) -> Representative:
    """POST /business-entities/{id}/representatives. Бутстрап: claim'нувший
    юрлицо (entity.claimed_by) может выдать САМ СЕБЕ первого представителя
    без проверки permission — иначе некому было бы выдать первое
    MANAGE_REPRESENTATIVES. Это НЕ распространяется на выдачу третьим лицам —
    только granter == target_user == claimed_by; всё остальное (включая
    любую выдачу до того, как claimant сам стал представителем) требует
    permission на общих основаниях."""
    entities_services.assert_entity_operable(entity)

    is_claimant_self_bootstrap = (
        granter.id == target_user.id
        and entity.claimed_by_id == granter.id
        and not Representative.objects.filter(business_entity=entity, is_active=True).exists()
    )
    if not is_claimant_self_bootstrap and not has_permission(
        granter, entity, Representative.Permission.MANAGE_REPRESENTATIVES
    ):
        raise RepresentativePermissionDeniedError(
            "нужен permission manage_representatives, чтобы приглашать представителей"
        )

    representative, _created = Representative.objects.update_or_create(
        user=target_user,
        business_entity=entity,
        defaults={
            "role": role,
            "permissions": permissions if permissions is not None else _apply_role_preset(role),
            "is_active": True,
            "approved_by": granter,
        },
    )
    outbox.publish(
        "authority.representative_granted",
        subject={"type": "business_entity", "id": str(entity.id)},
        payload={"user_id": str(target_user.id), "role": role},
        actor={"user_id": str(granter.id)},
    )
    return representative


def has_permission(user: User, entity: BusinessEntity, permission: str) -> bool:
    return Representative.objects.filter(
        user=user, business_entity=entity, is_active=True, permissions__contains=[permission]
    ).exists()


@transaction.atomic
def update_representative(
    representative: Representative,
    actor: User,
    *,
    role: str | None = None,
    permissions: list[str] | None = None,
    is_active: bool | None = None,
) -> Representative:
    if actor != representative.user and not has_permission(
        actor, representative.business_entity, Representative.Permission.MANAGE_REPRESENTATIVES
    ):
        raise RepresentativePermissionDeniedError(
            "нужен permission manage_representatives, чтобы менять чужие права"
        )
    update_fields = []
    if role is not None:
        representative.role = role
        update_fields.append("role")
    if permissions is not None:
        representative.permissions = permissions
        update_fields.append("permissions")
    if is_active is not None:
        representative.is_active = is_active
        update_fields.append("is_active")
    if update_fields:
        representative.save(update_fields=update_fields)
    return representative


@transaction.atomic
def grant_signing_authority(
    entity: BusinessEntity,
    granter: User,
    target_user: User,
    *,
    basis: str,
    max_amount: Money | None = None,
    proof: dict[str, Any] | None = None,
) -> SigningAuthority:
    """POST /business-entities/{id}/signing-authorities (ADR-004): для форм
    с разделённой собственностью MANUAL_REVIEW запрещена — 403.
    REGISTRY_VERIFIED_DIRECTOR требует совпадения ФИО с реестром. Право
    подписи — ВЫСОКИЙ риск (domain-model.md §4): выдавать его может только
    claimant либо представитель с manage_representatives — то же правило,
    что и на выдачу самого представительства."""
    entities_services.assert_entity_operable(entity)

    if granter.id != entity.claimed_by_id and not has_permission(
        granter, entity, Representative.Permission.MANAGE_REPRESENTATIVES
    ):
        raise RepresentativePermissionDeniedError(
            "нужен permission manage_representatives, чтобы выдавать право подписи"
        )

    if entity.has_separated_ownership() and basis == SigningAuthority.Basis.MANUAL_REVIEW:
        raise ManualReviewNotAllowedForSeparatedOwnershipError(
            "для этой формы собственности нужен верифицированный директор или "
            "нотариальная доверенность — ручная экспертиза запрещена (ADR-004)"
        )
    if basis == SigningAuthority.Basis.REGISTRY_VERIFIED_DIRECTOR and not (
        entities_services.director_full_name_matches(entity, target_user)
    ):
        raise DirectorMismatchError("ФИО не совпадает с директором по реестру")

    poa_registry_id = (proof or {}).get("poa_registry_id", "")

    authority = SigningAuthority.objects.create(
        user=target_user,
        business_entity=entity,
        basis=basis,
        max_amount_value=max_amount.amount if max_amount is not None else None,
        max_amount_currency=max_amount.currency if max_amount is not None else None,
        poa_registry_id=poa_registry_id,
        last_verified_at=timezone.now(),
    )
    outbox.publish(
        "authority.signing_authority_granted",
        subject={"type": "business_entity", "id": str(entity.id)},
        payload={"user_id": str(target_user.id), "basis": basis},
        actor={"user_id": str(granter.id)},
    )
    return authority


@transaction.atomic
def revoke_signing_authority(authority: SigningAuthority, actor: User) -> SigningAuthority:
    """DELETE /business-entities/{id}/signing-authorities/{sid}. Отзыв НЕ
    трогает уже поставленные подписи — те живут как снепшот на стороне
    evidence/contracts, эта запись только перестаёт быть валидной ВПЕРЁД."""
    authority.is_active = False
    authority.save(update_fields=["is_active"])
    outbox.publish(
        "authority.signing_authority_revoked",
        subject={"type": "business_entity", "id": str(authority.business_entity_id)},
        payload={"user_id": str(authority.user_id), "reason": "manual"},
        actor={"user_id": str(actor.id)},
    )
    return authority


def revoke_all_signing_authorities(entity: BusinessEntity, *, reason: str) -> int:
    """domain-model.md §3.2.2/§4 (revoke_all_authorities): вызывается
    apps.entities.services.dispute_claim при возврате карточки законному
    директору — аннулирует полномочия захватчика. Возвращает число
    отозванных записей."""
    updated = SigningAuthority.objects.filter(business_entity=entity, is_active=True).update(
        is_active=False
    )
    if updated:
        outbox.publish(
            "authority.signing_authority_revoked",
            subject={"type": "business_entity", "id": str(entity.id)},
            payload={"count": updated, "reason": reason},
            actor={},
        )
    return updated


def is_valid_now(authority: SigningAuthority, *, poa_provider: PoaRegistryProvider) -> bool:
    """domain-model.md §4: для МЧД-оснований перепроверяем по реестру ПРИ
    КАЖДОМ обращении — доверенность могла быть отозвана после выдачи."""
    if not authority.is_active:
        return False
    if authority.expires_at and authority.expires_at < timezone.now():
        return False
    if authority.basis in SigningAuthority.POA_VERIFIED_BASES:
        return poa_provider.check_poa_active(authority.poa_registry_id)
    return True


def can_sign_amount(authority: SigningAuthority, amount: Money) -> bool:
    if not authority.is_active:
        return False
    if authority.max_amount_value is None:
        return True
    max_amount = Money(authority.max_amount_value, authority.max_amount_currency or amount.currency)
    return amount <= max_amount


class SigningAuthorityNoLongerValidError(ValueError):
    """Право подписи, зафиксированное при маршрутизации, к моменту подписи
    невалидно: отозвано/истекло, МЧД отозвана по реестру или сумма договора
    вышла за лимит (ADR-096; domain-model.md §4 — перепроверка при КАЖДОМ
    подписании)."""


# «Сильнейшее» основание при нескольких правах одного пользователя —
# server-side детерминизм выбора (ADR-096): реестровый директор надёжнее
# доверенности, доверенность — передоверия, ручная экспертиза — последняя.
_BASIS_STRENGTH: dict[str, int] = {
    SigningAuthority.Basis.REGISTRY_VERIFIED_DIRECTOR: 0,
    SigningAuthority.Basis.NOTARIZED_POA: 1,
    SigningAuthority.Basis.CHAINED_DELEGATION: 2,
    SigningAuthority.Basis.MANUAL_REVIEW: 3,
}


def eligible_signatories(
    entity_id: Any,
    *,
    amount: Money | None,
    poa_provider: PoaRegistryProvider = DEFAULT_POA_PROVIDER,
) -> list[SigningAuthority]:
    """Фасад для контура подписания (ADR-096, `apps.contracts.services.
    list_signatories`): действующие права подписи юрлица, проходящие по
    лимиту суммы, — по одному (сильнейшему) на пользователя. `amount=None` —
    сумма договора ещё неизвестна (дерево пусто, до заморозки): фильтр по
    лимиту не применяется — маршрутизация/подпись возможны только после
    заморозки и перепроверяют лимит по реальной сумме."""
    best: dict[Any, SigningAuthority] = {}
    for authority in selectors.list_signing_authorities(entity_id):
        if not is_valid_now(authority, poa_provider=poa_provider):
            continue
        if amount is not None and not can_sign_amount(authority, amount):
            continue
        current = best.get(authority.user_id)
        if current is None or _BASIS_STRENGTH[authority.basis] < _BASIS_STRENGTH[current.basis]:
            best[authority.user_id] = authority
    return sorted(best.values(), key=lambda a: (_BASIS_STRENGTH[a.basis], str(a.user_id)))


def assert_can_sign(
    authority_id: Any,
    *,
    amount: Money | None,
    poa_provider: PoaRegistryProvider = DEFAULT_POA_PROVIDER,
) -> SigningAuthority:
    """Перепроверка права ПРИ ПОДПИСИ (ADR-096): между маршрутизацией и
    подписью доверенность могла быть отозвана, право — истечь, сумма — стать
    известной. Возвращает право для слепка в `Signature.entity_snapshot`."""
    authority = SigningAuthority.objects.filter(pk=authority_id).first()
    if authority is None or not is_valid_now(authority, poa_provider=poa_provider):
        raise SigningAuthorityNoLongerValidError(
            f"право подписи {authority_id} недействительно на момент подписания"
        )
    if amount is not None and not can_sign_amount(authority, amount):
        raise SigningAuthorityNoLongerValidError(
            f"право подписи {authority_id} не проходит по лимиту суммы {amount}"
        )
    return authority


@transaction.atomic
def assign_to_contract(
    representative: Representative,
    granter: User,
    *,
    contract_id: Any,
    milestone_ids: list[Any] | None = None,
    valid_from: Any = None,
    valid_until: Any = None,
) -> ContractAssignment:
    """POST-эквивалент модели (без HTTP-эндпоинта — tech-spec §8.2/§8.3 его
    не описывает; реально заработает в apps.evidence, etap-3.md 3.5)."""
    return ContractAssignment.objects.create(
        representative=representative,
        contract_id=contract_id,
        milestone_ids=milestone_ids,
        granted_by=granter,
        valid_from=valid_from or timezone.now(),
        valid_until=valid_until,
    )


def assignment_valid_at(
    assignment: ContractAssignment,
    *,
    user: User,
    contract_id: Any,
    milestone_id: Any = None,
    at: Any,
) -> bool:
    """ADR-053 п.1 / ADR-136 п.6: действовало ли назначение В МОМЕНТ СЪЁМКИ
    (`captured_at_device`), а не в момент выгрузки — «отзыв назначения не
    аннулирует материал, снятый в период его действия» (принцип снепшота
    полномочий ADR-005). Условия: назначение на ЭТОТ договор; съёмку делал
    сам назначенный представитель с правом `upload_evidence`; момент внутри
    [valid_from, valid_until] и до `revoked_at`; если назначение сужено до
    этапов — этап в списке."""
    if str(assignment.contract_id) != str(contract_id):
        return False
    representative = assignment.representative
    if representative.user_id != user.id:
        return False
    if not representative.can(Representative.Permission.UPLOAD_EVIDENCE):
        return False
    if at < assignment.valid_from:
        return False
    if assignment.valid_until is not None and at > assignment.valid_until:
        return False
    if assignment.revoked_at is not None and at > assignment.revoked_at:
        return False
    if not assignment.milestone_ids:
        return True
    allowed = {str(m) for m in assignment.milestone_ids}
    return milestone_id is not None and str(milestone_id) in allowed


def revoke_assignment(assignment: ContractAssignment) -> ContractAssignment:
    assignment.revoked_at = timezone.now()
    assignment.save(update_fields=["revoked_at"])
    return assignment
