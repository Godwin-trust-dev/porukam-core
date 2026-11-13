"""Гейт progressive KYC (tech-spec.md §7.4 п.1): строгая верификация
требуется на пороге чувствительного действия. Здесь применяется к одному
демонстрационному эндпоинту (api/views.py::VerificationGateDemoView) —
переиспользуется дальше: claim (3.4), лимиты SigningAuthority (3.5)."""

from __future__ import annotations

from rest_framework import status
from rest_framework.permissions import BasePermission
from rest_framework.request import Request
from rest_framework.views import APIView

from apps.accounts.models import User
from common.api.exceptions import DomainAPIError

_LEVEL_ORDER: list[str] = [
    User.VerificationLevel.GUEST,
    User.VerificationLevel.BASIC,
    User.VerificationLevel.VERIFIED,
    User.VerificationLevel.BUSINESS,
]


def require_verification(level: str) -> type[BasePermission]:
    """Фабрика DRF permission-класса:
    `permission_classes = [IsAuthenticated, require_verification(User.VerificationLevel.VERIFIED)]`.

    При недостаточном уровне поднимает `403 verification_required` с
    требуемым уровнем в `context` (tech-spec.md §7.4 п.1), а не просто
    возвращает False — иначе DRF отдал бы обобщённый `permission_denied`."""
    required_index = _LEVEL_ORDER.index(level)

    class _RequireVerificationLevel(BasePermission):
        def has_permission(self, request: Request, view: APIView) -> bool:
            user = request.user
            if user is None or not user.is_authenticated:
                return False
            try:
                current_index = _LEVEL_ORDER.index(user.verification_level)
            except ValueError:
                current_index = -1
            if current_index < required_index:
                raise DomainAPIError(
                    status_code=status.HTTP_403_FORBIDDEN,
                    code="verification_required",
                    title="Требуется более высокий уровень верификации",
                    detail=f"Требуемый уровень: {level}",
                    context={"required_level": level},
                )
            return True

    return _RequireVerificationLevel
