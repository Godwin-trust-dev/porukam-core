"""Read-слой apps.disputes (tech-spec.md §8.8)."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from django.db.models import QuerySet
from django.shortcuts import get_object_or_404

from apps.accounts.models import User
from apps.contracts import selectors as contracts_selectors
from apps.contracts.models import ContractParty
from apps.profiles import selectors as profiles_selectors

from .models import DiscountAgreement, Dispute, DisputeWindow, FixRequest

_SELECT_RELATED = (
    "contract",
    "milestone",
    "milestone__sphere",
    "checklist_item",
)


def get_dispute_or_404(dispute_id: UUID) -> Dispute:
    return get_object_or_404(Dispute.objects.select_related(*_SELECT_RELATED), pk=dispute_id)


def get_dispute(dispute_id: UUID) -> Dispute | None:
    """Спор по id для services-фасадов других приложений (apps.warranty
    хранит `dispute_id` по значению, без FK) — None вместо Http404: в
    use case'е 404 не место."""
    return Dispute.objects.select_related(*_SELECT_RELATED).filter(pk=dispute_id).first()


def get_fix_request_or_404(dispute: Dispute, fix_request_id: UUID) -> FixRequest:
    return get_object_or_404(
        FixRequest.objects.select_related("dispute__contract", "dispute__milestone"),
        pk=fix_request_id,
        dispute=dispute,
    )


def get_discount_agreement_or_404(dispute: Dispute, agreement_id: UUID) -> DiscountAgreement:
    return get_object_or_404(
        DiscountAgreement.objects.select_related(
            "dispute__contract", "dispute__milestone", "amendment", "milestone"
        ),
        pk=agreement_id,
        dispute=dispute,
    )


def list_for_user(
    user: User, *, status: str | None = None, kind: str | None = None
) -> QuerySet[Dispute]:
    """GET /disputes (tech-spec.md §8.8) — споры по договорам, где
    пользователь сторона (тот же путь, что `apps.contracts.selectors.
    list_my_contracts`: `user_owned_profile_ids`)."""
    owned = contracts_selectors.user_owned_profile_ids(user)
    qs = (
        Dispute.objects.filter(contract__parties__profile_id__in=owned)
        .select_related(*_SELECT_RELATED)
        .prefetch_related("fix_requests", "replies", "discount_agreements", "windows")
        .distinct()
    )
    if status is not None:
        qs = qs.filter(status=status)
    if kind is not None:
        qs = qs.filter(kind=kind)
    return qs.order_by("-opened_at")


def get_window_or_404(window_id: UUID) -> DisputeWindow:
    return get_object_or_404(
        DisputeWindow.objects.select_related("contract", "dispute"), pk=window_id
    )


def list_windows_for_user(user: User, *, active_only: bool = True) -> QuerySet[DisputeWindow]:
    """GET /dispute-windows (tech-spec.md §8.8) — «активные окна оспаривания
    текущего профиля (для дашборда)»."""
    owned = contracts_selectors.user_owned_profile_ids(user)
    qs = (
        DisputeWindow.objects.filter(contract__parties__profile_id__in=owned)
        .select_related("contract", "dispute")
        .distinct()
    )
    if active_only:
        qs = qs.filter(closed_at__isnull=True)
    return qs.order_by("-opened_at")


def counterparty_snapshot(
    dispute: Dispute, *, user: User, request: Any = None
) -> dict[str, Any] | None:
    """Вторая сторона договора ОТНОСИТЕЛЬНО читателя — `{profile_id,
    display_name, role, avatar_url}`.

    Отсмотр 25.08: `DisputeSerializer` отдавал только `contract_id`, и фронт
    (`web/src/pages/DisputesPage.tsx`) доставал контрагента из кэша
    `GET /contracts` — то есть раздел «Споры» молча терял вторую сторону,
    если список договоров ещё не загружен. `display_name` — тот же
    `apps.profiles.selectors.public_display_name`, что у дашбордов и
    репутационной карточки (профиль с `show_name=False` отдаёт None — это
    его согласие, а не ошибка).

    `avatar_url` (ADR-173) — то же фото, что в карточке профиля: зритель
    берётся из `request` (`avatar_url_for_request`, ADR-103), null — фото нет
    или зрителю нельзя. Профиль уже в `select_related` — лишнего запроса за
    ним нет."""
    owned = contracts_selectors.user_owned_profile_ids(user)
    other = (
        ContractParty.objects.filter(contract_id=dispute.contract_id)
        .exclude(profile_id__in=owned)
        .select_related("profile")
        .first()
    )
    if other is None:
        return None
    return {
        "profile_id": str(other.profile_id),
        "display_name": profiles_selectors.public_display_name(other.profile),
        "role": other.role,
        "avatar_url": profiles_selectors.avatar_url_for_request(other.profile, request),
    }


def has_open_disputes(contract_id: UUID) -> bool:
    """Есть ли по договору НЕЗАКРЫТОЕ разногласие любого вида (по этапу или
    гарантийное) — ADR-136: RetentionTimer доказательств возобновляется
    только когда закрыт ПОСЛЕДНИЙ спор, а не первый попавшийся."""
    return (
        Dispute.objects.filter(contract_id=contract_id)
        .exclude(status=Dispute.Status.RESOLVED)
        .exists()
    )


def list_for_contract(contract_id: UUID) -> QuerySet[Dispute]:
    """ADR-139: разногласия договора для доказательного пакета (apps.archive
    читает через фасад, не через модель) — в порядке открытия."""
    return Dispute.objects.filter(contract_id=contract_id).order_by("opened_at", "id")


# --- Удерживающие основания удаления аккаунта (ADR-169) ------------------
# Тот же приём, что `apps.contracts.selectors.account_deletion_holds`:
# apps.accounts зовёт это через `settings.ACCOUNT_DELETION_HOLDS` +
# `import_string`, прямого импорта apps.accounts -> apps.disputes нет и быть
# не может (import-linter: apps.social импортирует apps.accounts.services,
# и такой импорт «протёк» бы транзитивной зависимостью social -> disputes).


def count_open_disputes_for_user(user_id: Any) -> int:  # noqa: ANN401
    """Сколько НЕЗАКРЫТЫХ разногласий (любого вида — по этапу и гарантийных)
    у пользователя как стороны договора. Закрытый статус ровно один —
    `resolved`, поэтому `.exclude(...)`, а не белый список (тот же приём,
    что `has_open_disputes`)."""
    user = User.objects.filter(pk=user_id).first()
    if user is None:
        return 0
    owned = contracts_selectors.user_owned_profile_ids(user)
    if not owned:
        return 0
    return (
        Dispute.objects.filter(contract__parties__profile_id__in=owned)
        .exclude(status=Dispute.Status.RESOLVED)
        .distinct()
        .count()
    )


def account_deletion_holds(user_id: Any) -> dict[str, int]:  # noqa: ANN401
    """Вклад apps.disputes в `context` ответа 409 `account_deletion_blocked`."""
    return {"open_disputes": count_open_disputes_for_user(user_id)}
