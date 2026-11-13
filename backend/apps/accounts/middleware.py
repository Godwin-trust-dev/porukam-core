"""Контекст актёра (tech-spec.md §7.3): X-Acting-Profile → request.acting_profile_id.

etap-3.md 3.5: «профиль мой ЛИБО юрлица, где я активный Representative».
Проверка принадлежности живёт ЗДЕСЬ, а не в permission_classes конкретных
view — X-Acting-Profile общий для ЛЮБОГО эндпоинта, а не только профильных
(3.1: «фиксация в событиях» уже работает так). Единственная сложность:
raw Django-мидлварь выполняется ДО DRF-аутентификации (JWT разбирается
внутри APIView.dispatch(), не в цепочке Django-мидлварей) — поэтому здесь
JWT проверяется тем же JWTAuthentication напрямую, не через request.user
(тот на этом этапе — AnonymousUser сессионной аутентификации Django, JWT
ещё не резолвился). Если токен отсутствует/невалиден — проверку молча
пропускаем: отсутствие аутентификации отклонит IsAuthenticated самого view,
дублировать 401 здесь не нужно.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import cast

from django.http import HttpRequest, HttpResponse, JsonResponse
from rest_framework.exceptions import AuthenticationFailed
from rest_framework_simplejwt.authentication import JWTAuthentication

from apps.profiles import selectors as profile_selectors
from common.api.problem import PROBLEM_CONTENT_TYPE, problem_body

from .models import User

HEADER_NAME = "X-Acting-Profile"
_META_KEY = "HTTP_X_ACTING_PROFILE"

_jwt_auth = JWTAuthentication()


class ActingProfileMiddleware:
    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        request.acting_profile_id = None  # type: ignore[attr-defined]
        raw = request.META.get(_META_KEY)
        if raw:
            try:
                acting_profile_id = uuid.UUID(raw)
            except ValueError:
                return JsonResponse(
                    problem_body(
                        status=400,
                        code="invalid_acting_profile_header",
                        title=f"Заголовок {HEADER_NAME} должен быть UUID",
                        detail=raw,
                    ),
                    status=400,
                    content_type=PROBLEM_CONTENT_TYPE,
                )
            request.acting_profile_id = acting_profile_id  # type: ignore[attr-defined]

            user = _resolve_jwt_user(request)
            if user is not None and not profile_selectors.can_act_as(user, acting_profile_id):
                return JsonResponse(
                    problem_body(
                        status=403,
                        code="acting_profile_not_allowed",
                        title="Профиль не принадлежит вам и вы не представитель его юрлица",
                        detail=str(acting_profile_id),
                    ),
                    status=403,
                    content_type=PROBLEM_CONTENT_TYPE,
                )
        return self.get_response(request)


def _resolve_jwt_user(request: HttpRequest) -> User | None:
    try:
        result = _jwt_auth.authenticate(request)  # type: ignore[arg-type]
    except AuthenticationFailed:
        return None
    if result is None:
        return None
    user, _token = result
    return cast(User, user)
