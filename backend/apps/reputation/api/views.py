from __future__ import annotations

from typing import cast
from uuid import UUID

from django.utils import timezone
from drf_spectacular.utils import extend_schema
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import User
from apps.accounts.selectors import get_full_name
from apps.profiles import selectors as profiles_selectors
from apps.profiles.models import Profile
from apps.social import selectors as social_selectors

from .. import selectors
from .serializers import ReputationCardSerializer, ReputationInsightsSerializer


def _handle(profile: Profile) -> str | None:
    """Активный @handle владельца профиля (ADR-093) — публичный
    идентификатор карточки, открытой по `profile_id`. Прямой импорт
    apps.social.selectors, а не import_string: запрещающего контракта
    reputation→social нет (запрещено обратное), и вьюха уже композирует
    apps.profiles/apps.accounts тем же способом. Бизнес-профиль юрлица
    хендла не имеет — `Handle` принадлежит пользователю."""
    if profile.owner_user is None:
        return None
    handle = social_selectors.get_active_handle_for_user(profile.owner_user)
    return handle.value if handle is not None else None


def _groups(profile: Profile) -> list[dict[str, str | None]]:
    """ADR-117 §7: блок «состоит в объединениях» — активные членства
    владельца в публичных объединениях (закрытые не попадают по построению
    селектора). Тот же прямой импорт apps.social.selectors, что _handle."""
    if profile.owner_user is None:
        return []
    rows: list[dict[str, str | None]] = []
    for group in social_selectors.list_user_public_groups(profile.owner_user):
        handle = social_selectors.active_group_handle(group)
        rows.append(
            {
                "id": str(group.id),
                "name": group.name,
                "kind": group.kind,
                "handle": f"@{handle.value}" if handle else None,
            }
        )
    return rows


def _display_name(profile: Profile) -> str | None:
    if not profile.show_name:
        return None
    if profile.owner_user is not None:
        return get_full_name(profile.owner_user)
    if profile.owner_entity is not None:
        return profile.owner_entity.name
    return None


class ReputationCardView(APIView):
    """GET /reputation/profiles/{profile_id}/card — публичная карточка
    ГВ.4. Никакого DELETE/удаления отдельной сделки — намеренно (задача:
    «удаление отдельной сделки с карточки невозможно, нет такого API»)."""

    permission_classes = [AllowAny]

    @extend_schema(responses={200: ReputationCardSerializer})
    def get(self, request: Request, profile_id: UUID) -> Response:
        profile = profiles_selectors.get_profile_or_404(profile_id)
        # AllowAny — ЛЮБОЙ, включая анонимного, может задать заголовок
        # X-Acting-Profile: ActingProfileMiddleware проверяет владение ТОЛЬКО
        # если запрос нёс валидный JWT (докстринг middleware — «отсутствие
        # аутентификации отклонит IsAuthenticated самого view», у ЭТОГО view
        # IsAuthenticated нет). Без `request.user.is_authenticated` анонимный
        # гость мог бы подставить чужой profile_id и получить полную карточку
        # link_and_deals-профиля без реальной проверки владения — ADR-059
        # тут не про заголовок, а про факт аутентификации.
        viewer_profile_id = (
            getattr(request, "acting_profile_id", None) if request.user.is_authenticated else None
        )
        full = selectors.card_visible_in_full(profile, viewer_profile_id=viewer_profile_id)

        deals = list(selectors.completed_deals_for_profile(profile_id)) if full else []
        # ADR-163: агрегаты — производные от списка сделок, поэтому живут
        # ровно под тем же `full`, что и сам список (иначе стартовая
        # карточка сливала бы историю через цифру).
        aggregates = selectors.card_aggregates(profile_id) if full else None
        data = {
            "profile_id": profile.id,
            "kind": profile.kind,
            "display_name": _display_name(profile),
            # ADR-103: фото по тому же правилу, что и полная карточка —
            # `full` уже учёл public/владельца/контрагента (ADR-059).
            "avatar_url": profiles_selectors.avatar_url(
                profile,
                allowed=full or profile.avatar_visibility == Profile.AvatarVisibility.PUBLIC,
            ),
            "handle": _handle(profile),
            "profile_age_days": (timezone.now() - profile.created_at).days,
            "created_at": profile.created_at,
            "restricted": not full,
            "deals_count": selectors.deals_count(profile_id) if full else None,
            "counterparties_count": selectors.counterparties_count(profile_id) if full else None,
            "deals": deals,
            "groups": _groups(profile),
            # ADR-122: заявленные сферы — публичны как хендл (сам владелец
            # хочет находиться по ним), видны и на стартовой карточке.
            "sphere_codes": list(profile.sphere_codes or []),
            "by_role": aggregates["by_role"] if aggregates else None,
            "by_sphere": aggregates["by_sphere"] if aggregates else [],
            "disputes_free": aggregates["disputes_free"] if aggregates else None,
            "repeat_counterparties": aggregates["repeat_counterparties"] if aggregates else None,
            "last_deal_at": aggregates["last_deal_at"] if aggregates else None,
        }
        serializer = ReputationCardSerializer(data, context={"viewer_profile_id": profile_id})
        return Response(serializer.data)


class ReputationInsightsView(APIView):
    """GET /reputation/profiles/{profile_id}/insights (ADR-163 §8) —
    приватный разбор СВОЕЙ карточки: из чего сложилась каждая цифра,
    сколько осталось до зелёной зоны и что считается, но другим не
    показывается.

    В отличие от карточки — `IsAuthenticated`, а не `AllowAny`: у этого
    документа нет ни одной аудитории, кроме владельца профиля. Право
    проверяется `can_act_as` (тот же предикат, что у
    `ActingProfileMiddleware`), а НЕ сравнением с `acting_profile_id`:
    иначе владелец, забывший переключить актёра, получал бы 403 на
    собственные данные, а сама проверка зависела бы от заголовка."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: ReputationInsightsSerializer})
    def get(self, request: Request, profile_id: UUID) -> Response:
        profile = profiles_selectors.get_profile_or_404(profile_id)
        # `IsAuthenticated` уже отсёк AnonymousUser — сужение только для mypy.
        user = cast(User, request.user)
        if not profiles_selectors.can_act_as(user, profile.id):
            raise PermissionDenied("разбор репутации видит только владелец профиля")
        data = selectors.insights_for_profile(profile.id)
        return Response(ReputationInsightsSerializer(data).data)
