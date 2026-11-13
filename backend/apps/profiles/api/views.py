from __future__ import annotations

from typing import Any, cast
from uuid import UUID

from django.http import Http404, HttpResponse
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import User
from apps.authority import selectors as authority_selectors
from apps.entities import selectors as entities_selectors
from apps.entities import services as entities_services
from common.api.exceptions import DomainAPIError

from .. import selectors, services
from ..images import AVATAR_CONTENT_TYPE, AVATAR_SIZES, PORTFOLIO_SIZES, InvalidAvatarImageError
from ..models import Profile
from ..storage import build_avatar_store
from .serializers import (
    AvatarUploadSerializer,
    PortfolioProjectCreateSerializer,
    PortfolioProjectSerializer,
    PortfolioProjectUpdateSerializer,
    ProfileCreateSerializer,
    ProfileSerializer,
    ProfileUpdateSerializer,
    WorkAreaSerializer,
    WorkAreaWriteItemSerializer,
)


def _permission_denied(exc: Exception) -> DomainAPIError:
    return DomainAPIError(
        status_code=status.HTTP_403_FORBIDDEN,
        code="permission_denied",
        title="Редактировать может владелец либо представитель с manage_profile",
        detail=str(exc),
    )


class ProfileCreateView(APIView):
    """POST /profiles. person — идемпотентно возвращает существующий (тот
    уже создан при регистрации, subscriber.py); business — требует
    операбельного claim'нутого юрлица, где актёр — claimant либо активный
    представитель."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=ProfileCreateSerializer, responses={201: ProfileSerializer})
    def post(self, request: Request) -> Response:
        serializer = ProfileCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = cast(User, request.user)
        data = serializer.validated_data

        if data["kind"] == Profile.Kind.PERSON:
            profile = services.create_person_profile(user, profile_public=False)
            return Response(ProfileSerializer(profile).data, status=status.HTTP_200_OK)

        entity_id = data.get("owner_entity_id")
        if not entity_id:
            raise DomainAPIError(
                status_code=status.HTTP_400_BAD_REQUEST,
                code="invalid_request",
                title="owner_entity_id обязателен для business-профиля",
            )
        entity = entities_selectors.get_business_entity_or_404(entity_id)
        if entity.claimed_by_id != user.id and not authority_selectors.has_active_representative(
            user, entity_id
        ):
            raise DomainAPIError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="permission_denied",
                title="Создать бизнес-профиль может claim'нувший юрлицо либо представитель",
            )
        try:
            profile = services.create_business_profile(entity_id)
        except entities_services.EntityNotOperableError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="entity_not_operable",
                title="Контроль над юрлицом не подтверждён",
                detail=str(exc),
            ) from exc
        return Response(ProfileSerializer(profile).data, status=status.HTTP_201_CREATED)


class ProfileDetailView(APIView):
    permission_classes = [AllowAny]

    @extend_schema(responses={200: ProfileSerializer})
    def get(self, request: Request, profile_id: UUID) -> Response:
        profile = selectors.get_profile_or_404(profile_id)
        return Response(ProfileSerializer(profile, context={"request": request}).data)

    @extend_schema(request=ProfileUpdateSerializer, responses={200: ProfileSerializer})
    def patch(self, request: Request, profile_id: UUID) -> Response:
        profile = selectors.get_profile_or_404(profile_id)
        serializer = ProfileUpdateSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        try:
            profile = services.update_profile(
                profile, cast(User, request.user), **serializer.validated_data
            )
        except services.ProfilePermissionDeniedError as exc:
            raise _permission_denied(exc) from exc
        except services.ProfileSpheresLimitError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="profile_spheres_limit",
                title="Не больше 10 сфер",
                detail=str(exc),
            ) from exc
        except services.ProfileSpheresInvalidError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="invalid_sphere",
                title="Неизвестная сфера",
                detail=str(exc),
            ) from exc
        except services.ProfileWorkTypesLimitError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="profile_work_types_limit",
                title=f"Не больше {services.PROFILE_MAX_WORK_TYPES} видов работ",
                detail=str(exc),
            ) from exc
        except services.ProfileWorkTypeSphereNotDeclaredError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="work_type_sphere_not_declared",
                title="Сфера вида работ не заявлена в профиле",
                detail=str(exc),
            ) from exc
        except services.ProfileWorkTypesInvalidError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="invalid_work_type",
                title="Неизвестный вид работ",
                detail=str(exc),
            ) from exc
        except services.ProfileVisibilityLockedError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_409_CONFLICT,
                code="profile_visibility_locked",
                title="Бизнес-профиль всегда публичен",
                detail=str(exc),
            ) from exc
        return Response(ProfileSerializer(profile, context={"request": request}).data)


def _work_area_errors(exc: Exception) -> DomainAPIError:
    if isinstance(exc, services.WorkAreaLimitError):
        return DomainAPIError(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code="work_area_limit",
            title=f"Не больше {services.WORK_AREA_MAX} регионов работы",
            detail=str(exc),
        )
    if isinstance(exc, services.WorkAreaDuplicateError):
        return DomainAPIError(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code="work_area_duplicate",
            title="Место указано в списке дважды",
            detail=str(exc),
        )
    if isinstance(exc, services.WorkAreaLocationMismatchError):
        return DomainAPIError(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code="work_area_location_mismatch",
            title="Город не принадлежит указанному региону/стране",
            detail=str(exc),
        )
    if isinstance(exc, services.WorkAreaUnknownLocationError):
        return DomainAPIError(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code="work_area_unknown_location",
            title="Объект справочника не найден",
            detail=str(exc),
        )
    return DomainAPIError(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        code="work_area_invalid_payload",
        title="Неверный набор полей для масштаба",
        detail=str(exc),
    )


class ProfileWorkAreasView(APIView):
    """GET/PUT /profiles/{id}/work-areas — регионы работы профиля (план
    11.09 §4, ADR-182). Приватный список (не витрина, в отличие от
    `GET /profiles/{id}`) — обе операции доступны только владельцу либо
    представителю с `manage_profile`, чужой профиль — 403."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: WorkAreaSerializer(many=True)})
    def get(self, request: Request, profile_id: UUID) -> Response:
        profile = selectors.get_profile_or_404(profile_id)
        try:
            services.assert_can_edit_profile(profile, cast(User, request.user))
        except services.ProfilePermissionDeniedError as exc:
            raise _permission_denied(exc) from exc
        areas = selectors.list_work_areas(profile)
        return Response(WorkAreaSerializer(areas, many=True, context={"request": request}).data)

    @extend_schema(
        request=WorkAreaWriteItemSerializer(many=True),
        responses={200: WorkAreaSerializer(many=True)},
    )
    def put(self, request: Request, profile_id: UUID) -> Response:
        profile = selectors.get_profile_or_404(profile_id)
        serializer = WorkAreaWriteItemSerializer(data=request.data, many=True)
        serializer.is_valid(raise_exception=True)
        try:
            areas = services.replace_work_areas(
                profile, cast(User, request.user), list(serializer.validated_data)
            )
        except services.ProfilePermissionDeniedError as exc:
            raise _permission_denied(exc) from exc
        except (
            services.WorkAreaLimitError,
            services.WorkAreaDuplicateError,
            services.WorkAreaLocationMismatchError,
            services.WorkAreaUnknownLocationError,
            services.WorkAreaInvalidPayloadError,
        ) as exc:
            raise _work_area_errors(exc) from exc
        return Response(WorkAreaSerializer(areas, many=True, context={"request": request}).data)


class ProfileAvatarView(APIView):
    """ADR-103. GET — сами байты (image/webp): public — всем, deals_only —
    владельцу/представителю по JWT либо по подписанному `t`. Нет фото или
    нельзя — 404 (приватное не раскрывает существование). POST — замена,
    DELETE — удаление (идемпотентно); оба — владелец/представитель с
    manage_profile."""

    permission_classes = [AllowAny]
    parser_classes = [MultiPartParser, FormParser]

    def get_permissions(self) -> list[Any]:
        if self.request.method in ("POST", "DELETE"):
            return [IsAuthenticated()]
        return [AllowAny()]

    @extend_schema(responses={(200, AVATAR_CONTENT_TYPE): OpenApiTypes.BINARY})
    def get(self, request: Request, profile_id: UUID) -> HttpResponse:
        profile = selectors.get_profile_or_404(profile_id)
        if not profile.avatar_key:
            raise Http404
        try:
            size = int(request.query_params.get("size", AVATAR_SIZES[0]))
        except ValueError:
            size = AVATAR_SIZES[0]
        if size not in AVATAR_SIZES:
            size = AVATAR_SIZES[0]

        user = request.user if request.user.is_authenticated else None
        viewer_profile_id = getattr(request, "acting_profile_id", None) if user else None
        allowed = selectors.viewer_may_see_avatar(
            profile, viewer=user, viewer_profile_id=viewer_profile_id
        ) or selectors.avatar_token_valid(profile, request.query_params.get("t"))
        if not allowed:
            raise Http404

        body = build_avatar_store().get(services.avatar_object_key(profile.avatar_key, size))
        if body is None:
            raise Http404
        response = HttpResponse(body, content_type=AVATAR_CONTENT_TYPE)
        # URL версионирован (`v=`), поэтому кэшировать можно долго; private —
        # deals_only не должен оседать в общих кэшах.
        is_public = profile.avatar_visibility == Profile.AvatarVisibility.PUBLIC
        response["Cache-Control"] = (
            "public, max-age=86400" if is_public else "private, max-age=3600"
        )
        return response

    @extend_schema(request=AvatarUploadSerializer, responses={200: ProfileSerializer})
    def post(self, request: Request, profile_id: UUID) -> Response:
        profile = selectors.get_profile_or_404(profile_id)
        serializer = AvatarUploadSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        uploaded = serializer.validated_data["file"]
        try:
            profile = services.set_avatar(
                profile,
                cast(User, request.user),
                content=uploaded.read(),
                source=Profile.AvatarSource.UPLOAD,
            )
        except services.ProfilePermissionDeniedError as exc:
            raise _permission_denied(exc) from exc
        except services.AvatarTooLargeError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                code="avatar_too_large",
                title="Файл слишком большой",
                detail=str(exc),
            ) from exc
        except InvalidAvatarImageError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="invalid_avatar_image",
                title="Файл не распознан как изображение",
                detail=str(exc),
            ) from exc
        return Response(ProfileSerializer(profile, context={"request": request}).data)

    @extend_schema(responses={200: ProfileSerializer})
    def delete(self, request: Request, profile_id: UUID) -> Response:
        profile = selectors.get_profile_or_404(profile_id)
        try:
            profile = services.remove_avatar(profile, cast(User, request.user))
        except services.ProfilePermissionDeniedError as exc:
            raise _permission_denied(exc) from exc
        return Response(ProfileSerializer(profile, context={"request": request}).data)


class PortfolioProjectListCreateView(APIView):
    permission_classes = [AllowAny]

    @extend_schema(responses={200: PortfolioProjectSerializer(many=True)})
    def get(self, request: Request, profile_id: UUID) -> Response:
        profile = selectors.get_profile_or_404(profile_id)
        projects = selectors.list_portfolio_projects(profile)
        return Response(PortfolioProjectSerializer(projects, many=True).data)

    @extend_schema(
        request=PortfolioProjectCreateSerializer, responses={201: PortfolioProjectSerializer}
    )
    def post(self, request: Request, profile_id: UUID) -> Response:
        profile = selectors.get_profile_or_404(profile_id)
        serializer = PortfolioProjectCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            project = services.create_portfolio_project(
                profile, cast(User, request.user), **serializer.validated_data
            )
        except services.ProfilePermissionDeniedError as exc:
            raise _permission_denied(exc) from exc
        except services.PortfolioDatesInvalidError as exc:
            raise _dates_invalid(exc) from exc
        return Response(PortfolioProjectSerializer(project).data, status=status.HTTP_201_CREATED)


class PortfolioProjectDetailView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(
        request=PortfolioProjectUpdateSerializer, responses={200: PortfolioProjectSerializer}
    )
    def patch(self, request: Request, project_id: UUID) -> Response:
        project = selectors.get_project_or_404(project_id)
        serializer = PortfolioProjectUpdateSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        try:
            project = services.update_portfolio_project(
                project, cast(User, request.user), **serializer.validated_data
            )
        except services.ProfilePermissionDeniedError as exc:
            raise _permission_denied(exc) from exc
        except services.PortfolioDatesInvalidError as exc:
            raise _dates_invalid(exc) from exc
        return Response(PortfolioProjectSerializer(project).data)


class PortfolioProjectPublishView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: PortfolioProjectSerializer})
    def post(self, request: Request, project_id: UUID) -> Response:
        project = selectors.get_project_or_404(project_id)
        try:
            project = services.publish_project(project, cast(User, request.user))
        except services.ProfilePermissionDeniedError as exc:
            raise _permission_denied(exc) from exc
        except services.PortfolioConsentRequiredError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="portfolio_consent_required",
                title="Нужно согласие второй стороны договора",
                detail=str(exc),
            ) from exc
        return Response(PortfolioProjectSerializer(project).data)


def _dates_invalid(exc: Exception) -> DomainAPIError:
    return DomainAPIError(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        code="portfolio_dates_invalid",
        title="Укажите дату завершения проекта",
        detail=str(exc),
    )


def _photo_errors(exc: Exception) -> DomainAPIError:
    if isinstance(exc, services.AvatarTooLargeError):
        return DomainAPIError(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            code="portfolio_photo_too_large",
            title="Файл слишком большой",
            detail=str(exc),
        )
    return DomainAPIError(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        code="invalid_portfolio_image",
        title="Файл не распознан как изображение",
        detail=str(exc),
    )


def _serve_portfolio_bytes(request: Request, image_key: str) -> HttpResponse:
    try:
        size = int(request.query_params.get("size", PORTFOLIO_SIZES[0]))
    except ValueError:
        size = PORTFOLIO_SIZES[0]
    if size not in PORTFOLIO_SIZES:
        size = PORTFOLIO_SIZES[0]
    body = build_avatar_store().get(services.portfolio_object_key(image_key, size))
    if body is None:
        raise Http404
    response = HttpResponse(body, content_type=AVATAR_CONTENT_TYPE)
    response["Cache-Control"] = "public, max-age=86400"
    return response


class PortfolioProjectPhotosView(APIView):
    """ADR-120. POST /portfolio/projects/{id}/photos — добавить фото в
    галерею (до 5); владелец/представитель. 409 `portfolio_photos_limit`."""

    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]

    @extend_schema(request=AvatarUploadSerializer, responses={201: PortfolioProjectSerializer})
    def post(self, request: Request, project_id: UUID) -> Response:
        project = selectors.get_project_or_404(project_id)
        serializer = AvatarUploadSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            services.add_project_photo(
                project.portfolio.profile,
                cast(User, request.user),
                project,
                content=serializer.validated_data["file"].read(),
            )
        except services.ProfilePermissionDeniedError as exc:
            raise _permission_denied(exc) from exc
        except services.PortfolioPhotosLimitError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_409_CONFLICT,
                code="portfolio_photos_limit",
                title="Не больше 5 фото на проект",
                detail=str(exc),
            ) from exc
        except (services.AvatarTooLargeError, InvalidAvatarImageError) as exc:
            raise _photo_errors(exc) from exc
        project.refresh_from_db()
        return Response(PortfolioProjectSerializer(project).data, status=status.HTTP_201_CREATED)


class PortfolioProjectPhotoItemView(APIView):
    """ADR-120. GET — байты фото (AllowAny, витрина); DELETE — убрать фото
    (следующее становится основным)."""

    permission_classes = [AllowAny]

    def get_permissions(self) -> list[Any]:
        if self.request.method == "DELETE":
            return [IsAuthenticated()]
        return [AllowAny()]

    @extend_schema(responses={(200, AVATAR_CONTENT_TYPE): OpenApiTypes.BINARY})
    def get(self, request: Request, project_id: UUID, photo_id: UUID) -> HttpResponse:
        project = selectors.get_project_or_404(project_id)
        photo = selectors.get_project_photo_or_404(project, photo_id)
        return _serve_portfolio_bytes(request, photo.photo_key)

    @extend_schema(responses={200: PortfolioProjectSerializer})
    def delete(self, request: Request, project_id: UUID, photo_id: UUID) -> Response:
        project = selectors.get_project_or_404(project_id)
        photo = selectors.get_project_photo_or_404(project, photo_id)
        try:
            services.remove_project_photo_item(
                project.portfolio.profile, cast(User, request.user), project, photo
            )
        except services.ProfilePermissionDeniedError as exc:
            raise _permission_denied(exc) from exc
        project.refresh_from_db()
        return Response(PortfolioProjectSerializer(project).data)


class PortfolioProjectPhotoPrimaryView(APIView):
    """ADR-120. POST .../photos/{photo_id}/primary — сделать фото основным (первым)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: PortfolioProjectSerializer})
    def post(self, request: Request, project_id: UUID, photo_id: UUID) -> Response:
        project = selectors.get_project_or_404(project_id)
        photo = selectors.get_project_photo_or_404(project, photo_id)
        try:
            services.set_primary_project_photo(
                project.portfolio.profile, cast(User, request.user), project, photo
            )
        except services.ProfilePermissionDeniedError as exc:
            raise _permission_denied(exc) from exc
        project.refresh_from_db()
        return Response(PortfolioProjectSerializer(project).data)


class PortfolioProjectPhotoView(APIView):
    """ADR-115. GET — байты обложки (image/webp, size=1280|320): портфолио —
    витрина, published-проект виден всем (та же публичность, что карточка).
    POST/DELETE — владелец/представитель (manage_profile)."""

    permission_classes = [AllowAny]
    parser_classes = [MultiPartParser, FormParser]

    def get_permissions(self) -> list[Any]:
        if self.request.method in ("POST", "DELETE"):
            return [IsAuthenticated()]
        return [AllowAny()]

    @extend_schema(responses={(200, AVATAR_CONTENT_TYPE): OpenApiTypes.BINARY})
    def get(self, request: Request, project_id: UUID) -> HttpResponse:
        project = selectors.get_project_or_404(project_id)
        if not project.photo_key:
            raise Http404
        return _serve_portfolio_bytes(request, project.photo_key)

    @extend_schema(request=AvatarUploadSerializer, responses={200: PortfolioProjectSerializer})
    def post(self, request: Request, project_id: UUID) -> Response:
        project = selectors.get_project_or_404(project_id)
        profile = project.portfolio.profile
        serializer = AvatarUploadSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            project = services.set_project_photo(
                profile,
                cast(User, request.user),
                project,
                content=serializer.validated_data["file"].read(),
            )
        except services.ProfilePermissionDeniedError as exc:
            raise _permission_denied(exc) from exc
        except services.AvatarTooLargeError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                code="portfolio_photo_too_large",
                title="Файл слишком большой",
                detail=str(exc),
            ) from exc
        except InvalidAvatarImageError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="invalid_portfolio_image",
                title="Файл не распознан как изображение",
                detail=str(exc),
            ) from exc
        return Response(PortfolioProjectSerializer(project).data)

    @extend_schema(responses={200: PortfolioProjectSerializer})
    def delete(self, request: Request, project_id: UUID) -> Response:
        project = selectors.get_project_or_404(project_id)
        profile = project.portfolio.profile
        try:
            project = services.remove_project_photo(profile, cast(User, request.user), project)
        except services.ProfilePermissionDeniedError as exc:
            raise _permission_denied(exc) from exc
        return Response(PortfolioProjectSerializer(project).data)
