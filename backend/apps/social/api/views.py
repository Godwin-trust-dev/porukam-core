from __future__ import annotations

from typing import cast
from uuid import UUID

from django.http import Http404, HttpResponse
from django.shortcuts import get_object_or_404
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import status
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import User
from common.api.exceptions import DomainAPIError
from common.images import WEBP_CONTENT_TYPE, InvalidImageError
from common.net import client_ip

from .. import selectors, services
from ..models import AddressableGroup, Consent, GroupMembership
from ..storage import build_group_media_store, build_logo_store
from .serializers import (
    ConsentRecordSerializer,
    ConsentStateSerializer,
    ContactCreateSerializer,
    ContactSerializer,
    GlobalConsentStateSerializer,
    GlobalPrivacyConsentsSerializer,
    GroupCreateSerializer,
    GroupHandleSerializer,
    GroupLogoUploadSerializer,
    GroupPortfolioPhotoUploadSerializer,
    GroupPortfolioProjectCreateSerializer,
    GroupPortfolioProjectSerializer,
    GroupPortfolioProjectUpdateSerializer,
    GroupSerializer,
    GroupUpdateSerializer,
    HandleClaimSerializer,
    HandlePublicSerializer,
    HandleSearchListSerializer,
    HandleSearchResultSerializer,
    MembershipCreateSerializer,
    MembershipRowSerializer,
    MembershipSerializer,
    MembershipUpdateSerializer,
    PhonebookMatchSerializer,
    PhonebookUploadSerializer,
    PrivacyConsentsSerializer,
    ReputationLinkSerializer,
)


class HandleSearchView(APIView):
    """GET /handles?q=<префикс>&limit= — префикс-поиск хендлов для выбора
    контрагента в мастере создания договора (docs/tasks/
    audit-web-api-contract-sweep-report.md «Handle-поиск контрагента»).

    Только чтение. В отличие от HandlePublicView (точный лукап, AllowAny) —
    ТРЕБУЕТ аутентификации: перебор префиксов по всему справочнику хендлов
    анониму не отдаём.

    `q` короче selectors.HANDLE_SEARCH_MIN_PREFIX (и пустой) → 200 с пустым
    `results`, не 400: набор строки по символу — нормальное состояние ввода,
    а не ошибка (то же решение, что у GET /spheres?q= в apps.catalog).
    """

    permission_classes = [IsAuthenticated]

    @extend_schema(
        parameters=[
            OpenApiParameter(
                "q", str, description="Префикс хендла (с «@» или без), от 2 символов."
            ),
            OpenApiParameter("limit", int, description="Размер выдачи, 1..50 (по умолчанию 20)."),
        ],
        responses={200: HandleSearchListSerializer},
    )
    def get(self, request: Request) -> Response:
        try:
            limit = int(request.query_params.get("limit") or selectors.HANDLE_SEARCH_DEFAULT_LIMIT)
        except ValueError:
            limit = selectors.HANDLE_SEARCH_DEFAULT_LIMIT
        handles = selectors.search_handles(
            prefix=request.query_params.get("q") or "",
            viewer=cast(User, request.user),
            limit=limit,
        )
        return Response({"results": HandleSearchResultSerializer(handles, many=True).data})


class HandlePublicView(APIView):
    """GET /handles/{handle} — публично, без авторизации (etap-3.md 3.3
    приёмка: карточка со статусом верификации, БЕЗ trust_id)."""

    permission_classes = [AllowAny]

    @extend_schema(responses={200: HandlePublicSerializer})
    def get(self, request: Request, handle: str) -> Response:
        obj = selectors.get_active_handle_or_404(handle)
        return Response(HandlePublicSerializer(obj).data)


class MyHandleView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(request=HandleClaimSerializer, responses={200: HandlePublicSerializer})
    def post(self, request: Request) -> Response:
        serializer = HandleClaimSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            handle = services.claim_handle(
                user=cast(User, request.user), value=serializer.validated_data["value"]
            )
        except services.InvalidHandleFormatError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="invalid_handle_format",
                title="Недопустимый формат хендла",
                detail=str(exc),
            ) from exc
        except services.HandleTakenError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_409_CONFLICT,
                code="handle_taken",
                title="Хендл уже занят",
                detail=str(exc),
            ) from exc
        return Response(HandlePublicSerializer(handle).data)


class PhonebookView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(
        request=PhonebookUploadSerializer, responses={200: PhonebookMatchSerializer(many=True)}
    )
    def post(self, request: Request) -> Response:
        serializer = PhonebookUploadSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            matches = services.reconcile_phonebook(
                cast(User, request.user),
                hashes=serializer.validated_data["hashes"],
                algorithm=serializer.validated_data["algorithm"],
                salt_ref=serializer.validated_data["salt_ref"],
            )
        except services.InvalidPhonebookHashError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="invalid_phonebook_hash",
                title="Ожидались хеши, не сырые номера",
                detail=str(exc),
            ) from exc
        return Response(PhonebookMatchSerializer(matches, many=True).data)


class ContactListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: ContactSerializer(many=True)})
    def get(self, request: Request) -> Response:
        contacts = selectors.list_contacts(cast(User, request.user))
        return Response(ContactSerializer(contacts, many=True).data)

    @extend_schema(request=ContactCreateSerializer, responses={201: ContactSerializer})
    def post(self, request: Request) -> Response:
        serializer = ContactCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        target_user = None
        if data.get("target_user_id"):
            target_user = User.objects.filter(pk=data["target_user_id"]).first()
            if target_user is None:
                raise DomainAPIError(
                    status_code=status.HTTP_404_NOT_FOUND,
                    code="not_found",
                    title="Пользователь не найден",
                )
        elif data.get("target_handle"):
            target_user = selectors.get_active_handle_or_404(data["target_handle"]).user
            if target_user is None:
                raise DomainAPIError(
                    status_code=status.HTTP_404_NOT_FOUND,
                    code="not_found",
                    title="Хендл принадлежит объединению, не пользователю",
                )
        contact = services.add_contact(
            cast(User, request.user),
            target_user=target_user,
            source="manual",
            display_name=data.get("display_name") or None,
        )
        return Response(ContactSerializer(contact).data, status=status.HTTP_201_CREATED)


class ContactDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def delete(self, request: Request, contact_id: UUID) -> Response:
        contact = selectors.get_contact_or_404(cast(User, request.user), contact_id)
        services.remove_contact(contact)
        return Response(status=status.HTTP_204_NO_CONTENT)


class ReputationLinkView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: ReputationLinkSerializer})
    def get(self, request: Request) -> Response:
        try:
            url = services.build_reputation_link(cast(User, request.user))
        except services.HandleRequiredForReputationLinkError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="handle_required",
                title="Нужен активный @handle",
                detail=str(exc),
            ) from exc
        return Response(ReputationLinkSerializer({"url": url}).data)


def _consent_state(user: User) -> dict[str, object]:
    latest = selectors.latest_consents(user)
    return {
        "pd_processing": latest[Consent.ConsentType.PD_PROCESSING].value
        if Consent.ConsentType.PD_PROCESSING in latest
        else None,
        "profile_public": latest[Consent.ConsentType.PROFILE_PUBLIC].value
        if Consent.ConsentType.PROFILE_PUBLIC in latest
        else None,
        "phone_discoverability": latest[Consent.ConsentType.PHONE_DISCOVERABILITY].value
        if Consent.ConsentType.PHONE_DISCOVERABILITY in latest
        else None,
        "completed": selectors.is_privacy_step_complete(user),
    }


def _global_consent_state(user: User) -> dict[str, object]:
    latest = selectors.latest_consents(user)
    state: dict[str, object] = {
        str(consent_type): latest[consent_type].value if consent_type in latest else None
        for consent_type in (
            Consent.ConsentType.PD_PROCESSING,
            Consent.ConsentType.PROFILE_PUBLIC,
            Consent.ConsentType.PHONE_DISCOVERABILITY,
            Consent.ConsentType.REPUTATION_HISTORY_BASIS,
        )
    }
    state["completed"] = selectors.is_global_privacy_step_complete(user)
    return state


class PrivacyConsentsView(APIView):
    """Шаг регистрации «Данные и приватность» (docs/tasks/
    etap-3-delta-adr059.md §1.1) — все три согласия ОДНИМ действием."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: ConsentStateSerializer})
    def get(self, request: Request) -> Response:
        return Response(ConsentStateSerializer(_consent_state(cast(User, request.user))).data)

    @extend_schema(request=PrivacyConsentsSerializer, responses={200: ConsentStateSerializer})
    def post(self, request: Request) -> Response:
        serializer = PrivacyConsentsSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = cast(User, request.user)
        try:
            services.complete_privacy_step(
                user,
                pd_processing=serializer.validated_data["pd_processing"],
                profile_public=serializer.validated_data["profile_public"],
                phone_discoverability=serializer.validated_data["phone_discoverability"],
                device=request.META.get("HTTP_USER_AGENT", "")[:255],
                ip=client_ip(request),
            )
        except services.PdProcessingConsentRequiredError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="pd_processing_consent_required",
                title="Без согласия на обработку персональных данных регистрация невозможна",
                detail=str(exc),
            ) from exc
        return Response(ConsentStateSerializer(_consent_state(user)).data)


class GlobalPrivacyConsentsView(APIView):
    """Шаг регистрации «Данные и приватность» для контура GLOBAL (ГВ.2,
    docs/tasks/global-wave.md, ADR-071) — те же три согласия, что
    PrivacyConsentsView, + четвёртое (история сделок в репутации), тексты
    записываются как EN (locale, services.complete_global_privacy_step)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: GlobalConsentStateSerializer})
    def get(self, request: Request) -> Response:
        state = _global_consent_state(cast(User, request.user))
        return Response(GlobalConsentStateSerializer(state).data)

    @extend_schema(
        request=GlobalPrivacyConsentsSerializer, responses={200: GlobalConsentStateSerializer}
    )
    def post(self, request: Request) -> Response:
        serializer = GlobalPrivacyConsentsSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = cast(User, request.user)
        try:
            services.complete_global_privacy_step(
                user,
                pd_processing=serializer.validated_data["pd_processing"],
                profile_public=serializer.validated_data["profile_public"],
                phone_discoverability=serializer.validated_data["phone_discoverability"],
                reputation_history_basis=serializer.validated_data["reputation_history_basis"],
                device=request.META.get("HTTP_USER_AGENT", "")[:255],
                ip=client_ip(request),
            )
        except services.PdProcessingConsentRequiredError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="pd_processing_consent_required",
                title="Без согласия на обработку персональных данных регистрация невозможна",
                detail=str(exc),
            ) from exc
        return Response(GlobalConsentStateSerializer(_global_consent_state(user)).data)


class ConsentListCreateView(APIView):
    """POST /users/me/consents — изменение ОДНОГО согласия после
    регистрации (docs/tasks/etap-3-delta-adr059.md §2 тест 6)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: ConsentStateSerializer})
    def get(self, request: Request) -> Response:
        return Response(ConsentStateSerializer(_consent_state(cast(User, request.user))).data)

    @extend_schema(request=ConsentRecordSerializer, responses={200: ConsentStateSerializer})
    def post(self, request: Request) -> Response:
        serializer = ConsentRecordSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = cast(User, request.user)
        services.record_consent(
            user,
            consent_type=serializer.validated_data["consent_type"],
            value=serializer.validated_data["value"],
            device=request.META.get("HTTP_USER_AGENT", "")[:255],
            ip=client_ip(request),
        )
        return Response(ConsentStateSerializer(_consent_state(user)).data)


def _viewer(request: Request) -> User | None:
    """Аноним на публичных GET (ADR-117 §6) — None, не AnonymousUser: и
    selectors.my_membership, и get_visible_group_or_404 ждут User | None."""
    return request.user if request.user.is_authenticated else None


class GroupListCreateView(APIView):
    """GET — публичный список публичных объединений (ADR-117 §6, приём
    ProfileAvatarView: AllowAny на чтение, IsAuthenticated на запись)."""

    permission_classes = [AllowAny]

    def get_permissions(self) -> list[AllowAny | IsAuthenticated]:
        if self.request.method == "POST":
            return [IsAuthenticated()]
        return [AllowAny()]

    @extend_schema(responses={200: GroupSerializer(many=True)})
    def get(self, request: Request) -> Response:
        return Response(
            GroupSerializer(
                selectors.list_public_groups(), many=True, context={"viewer": _viewer(request)}
            ).data
        )

    @extend_schema(request=GroupCreateSerializer, responses={201: GroupSerializer})
    def post(self, request: Request) -> Response:
        serializer = GroupCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            group = services.create_group(cast(User, request.user), **serializer.validated_data)
        except services.InvalidGroupSphereError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="invalid_sphere",
                title="Неизвестная сфера деятельности",
                detail=str(exc),
            ) from exc
        except services.InvalidGroupGeoError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="invalid_geo",
                title="География указана не полностью",
                detail=str(exc),
            ) from exc
        except services.InvalidHandleFormatError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="invalid_handle",
                title="Хендл — 3–32 символа: латиница, цифры, подчёркивание",
                detail=str(exc),
            ) from exc
        except services.HandleTakenError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_409_CONFLICT,
                code="handle_taken",
                title="Такой хендл уже занят",
            ) from exc
        return Response(
            GroupSerializer(group, context={"viewer": request.user}).data,
            status=status.HTTP_201_CREATED,
        )


class GroupDetailView(APIView):
    """GET — публичная карточка объединения (ADR-117 §6): аноним видит
    только is_public, чужое приватное — 404."""

    permission_classes = [AllowAny]

    def get_permissions(self) -> list[AllowAny | IsAuthenticated]:
        if self.request.method == "PATCH":
            return [IsAuthenticated()]
        return [AllowAny()]

    @extend_schema(responses={200: GroupSerializer})
    def get(self, request: Request, group_id: UUID) -> Response:
        viewer = _viewer(request)
        return Response(
            GroupSerializer(
                selectors.get_visible_group_or_404(group_id, viewer=viewer),
                context={"viewer": viewer},
            ).data
        )

    @extend_schema(request=GroupUpdateSerializer, responses={200: GroupSerializer})
    def patch(self, request: Request, group_id: UUID) -> Response:
        group = selectors.get_group_or_404(group_id)
        serializer = GroupUpdateSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        try:
            group = services.update_group(
                group, cast(User, request.user), **serializer.validated_data
            )
        except services.GroupPermissionDeniedError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="permission_denied",
                title="Нужна роль leader/admin в объединении",
                detail=str(exc),
            ) from exc
        except services.InvalidGroupSphereError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="invalid_sphere",
                title="Неизвестная сфера деятельности",
                detail=str(exc),
            ) from exc
        except services.InvalidGroupGeoError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="invalid_geo",
                title="География указана не полностью",
                detail=str(exc),
            ) from exc
        return Response(GroupSerializer(group).data)


class GroupMemberListCreateView(APIView):
    """GET — публичный перечень УЧАСТНИКОВ (ADR-117 §6): заявки и
    приглашения видит только leader/admin — публичная карточка показывает
    состав, а не воронку вступления."""

    permission_classes = [AllowAny]

    def get_permissions(self) -> list[AllowAny | IsAuthenticated]:
        if self.request.method == "POST":
            return [IsAuthenticated()]
        return [AllowAny()]

    @extend_schema(responses={200: MembershipRowSerializer(many=True)})
    def get(self, request: Request, group_id: UUID) -> Response:
        viewer = _viewer(request)
        group = selectors.get_visible_group_or_404(group_id, viewer=viewer)
        rows = selectors.list_group_members(group)
        if viewer is None or not selectors.can_manage_group(group, viewer):
            rows = rows.filter(status=GroupMembership.Status.ACTIVE)
        return Response(MembershipRowSerializer(rows, many=True).data)

    @extend_schema(request=MembershipCreateSerializer, responses={201: MembershipSerializer})
    def post(self, request: Request, group_id: UUID) -> Response:
        group = selectors.get_group_or_404(group_id)
        serializer = MembershipCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        member = None
        if serializer.validated_data.get("member_id"):
            member = User.objects.filter(pk=serializer.validated_data["member_id"]).first()
        elif serializer.validated_data.get("handle"):
            handle_value = serializer.validated_data["handle"].strip().lstrip("@").lower()
            handle_row = selectors.get_active_handle_or_404(handle_value) if handle_value else None
            member = handle_row.user if handle_row is not None else None
        if member is None:
            raise DomainAPIError(
                status_code=status.HTTP_404_NOT_FOUND,
                code="not_found",
                title="Пользователь не найден",
            )
        try:
            membership = services.invite_member(
                group, cast(User, request.user), member, role=serializer.validated_data["role"]
            )
        except services.GroupPermissionDeniedError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="permission_denied",
                title="Нужна роль leader/admin в объединении",
                detail=str(exc),
            ) from exc
        return Response(MembershipSerializer(membership).data, status=status.HTTP_201_CREATED)


class GroupMemberDetailView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(request=MembershipUpdateSerializer, responses={200: MembershipSerializer})
    def patch(self, request: Request, group_id: UUID, member_id: UUID) -> Response:
        group = selectors.get_group_or_404(group_id)
        membership = selectors.get_membership_or_404(group, member_id)
        serializer = MembershipUpdateSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        try:
            membership = services.update_membership(
                group, cast(User, request.user), membership, **serializer.validated_data
            )
        except services.GroupPermissionDeniedError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="permission_denied",
                title="Нужна роль leader/admin в объединении",
                detail=str(exc),
            ) from exc
        return Response(MembershipSerializer(membership).data)

    def delete(self, request: Request, group_id: UUID, member_id: UUID) -> Response:
        group = selectors.get_group_or_404(group_id)
        membership = selectors.get_membership_or_404(group, member_id)
        try:
            services.remove_member(group, cast(User, request.user), membership)
        except services.GroupPermissionDeniedError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="permission_denied",
                title="Нужна роль leader/admin в объединении",
                detail=str(exc),
            ) from exc
        return Response(status=status.HTTP_204_NO_CONTENT)


class GroupJoinView(APIView):
    """POST /groups/{id}/join (отсмотр 2026-08-23): open — участник сразу,
    approval — заявка requested; приглашение принимается этим же вызовом."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=None, responses={200: MembershipRowSerializer})
    def post(self, request: Request, group_id: UUID) -> Response:
        group = selectors.get_group_or_404(group_id)
        membership = services.join_group(group, cast(User, request.user))
        return Response(MembershipRowSerializer(membership).data)


class GroupLeaveView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(request=None, responses={204: None})
    def post(self, request: Request, group_id: UUID) -> Response:
        group = selectors.get_group_or_404(group_id)
        try:
            services.leave_group(group, cast(User, request.user))
        except services.LeaderCannotLeaveError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_409_CONFLICT,
                code="leader_cannot_leave",
                title="Лидер не может выйти из объединения",
            ) from exc
        return Response(status=status.HTTP_204_NO_CONTENT)


class GroupJoinRequestDecisionView(APIView):
    """POST /groups/{id}/requests/{membership_id}/approve|reject — лидер/админ."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=None, responses={200: MembershipRowSerializer})
    def post(self, request: Request, group_id: UUID, membership_id: int, decision: str) -> Response:
        group = selectors.get_group_or_404(group_id)
        membership = get_object_or_404(GroupMembership, pk=membership_id, group=group)
        try:
            membership = services.decide_join_request(
                group, cast(User, request.user), membership, approve=(decision == "approve")
            )
        except services.GroupPermissionDeniedError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="permission_denied",
                title="Нужна роль leader/admin в объединении",
            ) from exc
        except services.JoinRequestNotPendingError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_409_CONFLICT,
                code="join_request_not_pending",
                title="Заявка уже решена",
            ) from exc
        return Response(MembershipRowSerializer(membership).data)


class GroupLogoView(APIView):
    """ADR-117 §8. GET — байты WebP (видимость — как у карточки: аноним
    только для публичных); POST — замена, DELETE — удаление (идемпотентно),
    оба — лидер/админ. Приём ProfileAvatarView (ADR-103)."""

    permission_classes = [AllowAny]
    parser_classes = [MultiPartParser, FormParser]

    def get_permissions(self) -> list[AllowAny | IsAuthenticated]:
        if self.request.method in ("POST", "DELETE"):
            return [IsAuthenticated()]
        return [AllowAny()]

    @extend_schema(responses={(200, WEBP_CONTENT_TYPE): OpenApiTypes.BINARY})
    def get(self, request: Request, group_id: UUID) -> HttpResponse:
        group = selectors.get_visible_group_or_404(group_id, viewer=_viewer(request))
        if not group.logo_key:
            raise Http404
        try:
            size = int(request.query_params.get("size", services.LOGO_SIZES[0]))
        except ValueError:
            size = services.LOGO_SIZES[0]
        if size not in services.LOGO_SIZES:
            size = services.LOGO_SIZES[0]
        body = build_logo_store().get(services.logo_object_key(group.logo_key, size))
        if body is None:
            raise Http404
        response = HttpResponse(body, content_type=WEBP_CONTENT_TYPE)
        # URL версионирован (`v=`) — кэшировать можно долго; приватные
        # объединения не должны оседать в общих кэшах.
        response["Cache-Control"] = (
            "public, max-age=86400" if group.is_public else "private, max-age=3600"
        )
        return response

    @extend_schema(request=GroupLogoUploadSerializer, responses={200: GroupSerializer})
    def post(self, request: Request, group_id: UUID) -> Response:
        group = selectors.get_group_or_404(group_id)
        serializer = GroupLogoUploadSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            group = services.set_group_logo(
                group,
                cast(User, request.user),
                content=serializer.validated_data["file"].read(),
            )
        except services.GroupPermissionDeniedError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="permission_denied",
                title="Нужна роль leader/admin в объединении",
            ) from exc
        except services.GroupLogoTooLargeError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                code="logo_too_large",
                title="Файл слишком большой",
                detail=str(exc),
            ) from exc
        except InvalidImageError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="invalid_logo_image",
                title="Файл не распознан как изображение",
                detail=str(exc),
            ) from exc
        return Response(GroupSerializer(group, context={"viewer": request.user}).data)

    @extend_schema(responses={200: GroupSerializer})
    def delete(self, request: Request, group_id: UUID) -> Response:
        group = selectors.get_group_or_404(group_id)
        try:
            group = services.remove_group_logo(group, cast(User, request.user))
        except services.GroupPermissionDeniedError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="permission_denied",
                title="Нужна роль leader/admin в объединении",
            ) from exc
        return Response(GroupSerializer(group, context={"viewer": request.user}).data)


class GroupHandleView(APIView):
    """POST /groups/{id}/handle — хендл объединения (лидер/админ)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=GroupHandleSerializer, responses={200: GroupSerializer})
    def post(self, request: Request, group_id: UUID) -> Response:
        group = selectors.get_group_or_404(group_id)
        serializer = GroupHandleSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            services.set_group_handle(
                group, cast(User, request.user), value=serializer.validated_data["value"]
            )
        except services.GroupPermissionDeniedError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="permission_denied",
                title="Нужна роль leader/admin в объединении",
            ) from exc
        except services.InvalidHandleFormatError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="invalid_handle",
                title="Хендл — 3–32 символа: латиница, цифры, подчёркивание",
                detail=str(exc),
            ) from exc
        except services.HandleTakenError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_409_CONFLICT,
                code="handle_taken",
                title="Такой хендл уже занят",
            ) from exc
        return Response(GroupSerializer(group, context={"viewer": request.user}).data)


# --- Портфолио объединения (ADR-128) ------------------------------------------


def _group_permission_denied(exc: Exception) -> DomainAPIError:
    return DomainAPIError(
        status_code=status.HTTP_403_FORBIDDEN,
        code="permission_denied",
        title="Нужна роль leader/admin в объединении",
        detail=str(exc),
    )


def _group_portfolio_dates_invalid(exc: Exception) -> DomainAPIError:
    return DomainAPIError(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        code="portfolio_dates_invalid",
        title="Укажите дату завершения проекта",
        detail=str(exc),
    )


def _group_portfolio_photo_error(exc: Exception) -> DomainAPIError:
    if isinstance(exc, services.GroupPortfolioPhotoTooLargeError):
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


def _managed_group_or_404(request: Request, group_id: UUID) -> AddressableGroup:
    """Для пишущих ручек: объединение берём БЕЗ фильтра публичности (админ
    закрытого объединения обязан управлять витриной), право проверяет сервис."""
    return selectors.get_group_or_404(group_id)


class GroupPortfolioProjectListCreateView(APIView):
    """ADR-128. GET — витрина работ объединения (AllowAny: видна ровно тем,
    кому видна сама карточка — приватное объединение аноним не видит вовсе);
    POST — создать проект, leader/admin."""

    permission_classes = [AllowAny]

    def get_permissions(self) -> list[AllowAny | IsAuthenticated]:
        if self.request.method == "POST":
            return [IsAuthenticated()]
        return [AllowAny()]

    @extend_schema(responses={200: GroupPortfolioProjectSerializer(many=True)})
    def get(self, request: Request, group_id: UUID) -> Response:
        group = selectors.get_visible_group_or_404(group_id, viewer=_viewer(request))
        projects = selectors.list_group_portfolio_projects(group)
        return Response(GroupPortfolioProjectSerializer(projects, many=True).data)

    @extend_schema(
        request=GroupPortfolioProjectCreateSerializer,
        responses={201: GroupPortfolioProjectSerializer},
    )
    def post(self, request: Request, group_id: UUID) -> Response:
        group = _managed_group_or_404(request, group_id)
        serializer = GroupPortfolioProjectCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            project = services.create_group_portfolio_project(
                group, cast(User, request.user), **serializer.validated_data
            )
        except services.GroupPermissionDeniedError as exc:
            raise _group_permission_denied(exc) from exc
        except services.GroupPortfolioDatesInvalidError as exc:
            raise _group_portfolio_dates_invalid(exc) from exc
        except services.InvalidGroupSphereError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="invalid_sphere",
                title="Неизвестная сфера каталога",
                detail=str(exc),
            ) from exc
        return Response(
            GroupPortfolioProjectSerializer(project).data, status=status.HTTP_201_CREATED
        )


class GroupPortfolioProjectDetailView(APIView):
    """ADR-128. GET — один проект (AllowAny, витрина: «работы кликабельны»);
    PATCH/DELETE — leader/admin."""

    permission_classes = [AllowAny]

    def get_permissions(self) -> list[AllowAny | IsAuthenticated]:
        if self.request.method in ("PATCH", "DELETE"):
            return [IsAuthenticated()]
        return [AllowAny()]

    @extend_schema(responses={200: GroupPortfolioProjectSerializer})
    def get(self, request: Request, group_id: UUID, project_id: UUID) -> Response:
        group = selectors.get_visible_group_or_404(group_id, viewer=_viewer(request))
        project = selectors.get_group_portfolio_project_or_404(group, project_id)
        return Response(GroupPortfolioProjectSerializer(project).data)

    @extend_schema(
        request=GroupPortfolioProjectUpdateSerializer,
        responses={200: GroupPortfolioProjectSerializer},
    )
    def patch(self, request: Request, group_id: UUID, project_id: UUID) -> Response:
        group = _managed_group_or_404(request, group_id)
        project = selectors.get_group_portfolio_project_or_404(group, project_id)
        serializer = GroupPortfolioProjectUpdateSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        try:
            project = services.update_group_portfolio_project(
                project, cast(User, request.user), **serializer.validated_data
            )
        except services.GroupPermissionDeniedError as exc:
            raise _group_permission_denied(exc) from exc
        except services.GroupPortfolioDatesInvalidError as exc:
            raise _group_portfolio_dates_invalid(exc) from exc
        except services.InvalidGroupSphereError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="invalid_sphere",
                title="Неизвестная сфера каталога",
                detail=str(exc),
            ) from exc
        return Response(GroupPortfolioProjectSerializer(project).data)

    @extend_schema(responses={204: None})
    def delete(self, request: Request, group_id: UUID, project_id: UUID) -> Response:
        group = _managed_group_or_404(request, group_id)
        project = selectors.get_group_portfolio_project_or_404(group, project_id)
        try:
            services.delete_group_portfolio_project(project, cast(User, request.user))
        except services.GroupPermissionDeniedError as exc:
            raise _group_permission_denied(exc) from exc
        return Response(status=status.HTTP_204_NO_CONTENT)


class GroupPortfolioPhotosView(APIView):
    """ADR-128. POST .../photos — добавить фото в галерею (до 5), leader/admin.
    409 `portfolio_photos_limit` на шестое."""

    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]

    @extend_schema(
        request=GroupPortfolioPhotoUploadSerializer,
        responses={201: GroupPortfolioProjectSerializer},
    )
    def post(self, request: Request, group_id: UUID, project_id: UUID) -> Response:
        group = _managed_group_or_404(request, group_id)
        project = selectors.get_group_portfolio_project_or_404(group, project_id)
        serializer = GroupPortfolioPhotoUploadSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            services.add_group_portfolio_photo(
                project,
                cast(User, request.user),
                content=serializer.validated_data["file"].read(),
            )
        except services.GroupPermissionDeniedError as exc:
            raise _group_permission_denied(exc) from exc
        except services.GroupPortfolioPhotosLimitError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_409_CONFLICT,
                code="portfolio_photos_limit",
                title="Не больше 5 фото на проект",
                detail=str(exc),
            ) from exc
        except (services.GroupPortfolioPhotoTooLargeError, InvalidImageError) as exc:
            raise _group_portfolio_photo_error(exc) from exc
        project.refresh_from_db()
        return Response(
            GroupPortfolioProjectSerializer(project).data, status=status.HTTP_201_CREATED
        )


class GroupPortfolioPhotoItemView(APIView):
    """ADR-128. GET — байты WebP (size=1280|320; видимость — как у карточки
    объединения); DELETE — убрать фото, leader/admin (следующее становится
    основным)."""

    permission_classes = [AllowAny]

    def get_permissions(self) -> list[AllowAny | IsAuthenticated]:
        if self.request.method == "DELETE":
            return [IsAuthenticated()]
        return [AllowAny()]

    @extend_schema(
        parameters=[OpenApiParameter("size", int, OpenApiParameter.QUERY)],
        responses={(200, WEBP_CONTENT_TYPE): OpenApiTypes.BINARY},
    )
    def get(
        self, request: Request, group_id: UUID, project_id: UUID, photo_id: UUID
    ) -> HttpResponse:
        group = selectors.get_visible_group_or_404(group_id, viewer=_viewer(request))
        project = selectors.get_group_portfolio_project_or_404(group, project_id)
        photo = selectors.get_group_portfolio_photo_or_404(project, photo_id)
        sizes = services.GROUP_PORTFOLIO_SIZES
        try:
            size = int(request.query_params.get("size", sizes[0]))
        except ValueError:
            size = sizes[0]
        if size not in sizes:
            size = sizes[0]
        body = build_group_media_store().get(
            services.group_portfolio_object_key(photo.photo_key, size)
        )
        if body is None:
            raise Http404
        response = HttpResponse(body, content_type=WEBP_CONTENT_TYPE)
        # URL версионирован (`v=`) — кэш долгий; витрина закрытого объединения
        # не должна оседать в общих кэшах (как логотип).
        response["Cache-Control"] = (
            "public, max-age=86400" if group.is_public else "private, max-age=3600"
        )
        return response

    @extend_schema(responses={200: GroupPortfolioProjectSerializer})
    def delete(
        self, request: Request, group_id: UUID, project_id: UUID, photo_id: UUID
    ) -> Response:
        group = _managed_group_or_404(request, group_id)
        project = selectors.get_group_portfolio_project_or_404(group, project_id)
        photo = selectors.get_group_portfolio_photo_or_404(project, photo_id)
        try:
            services.remove_group_portfolio_photo(project, cast(User, request.user), photo)
        except services.GroupPermissionDeniedError as exc:
            raise _group_permission_denied(exc) from exc
        project.refresh_from_db()
        return Response(GroupPortfolioProjectSerializer(project).data)


class GroupPortfolioPhotoPrimaryView(APIView):
    """ADR-128. POST .../photos/{photo_id}/primary — сделать фото основным."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: GroupPortfolioProjectSerializer})
    def post(self, request: Request, group_id: UUID, project_id: UUID, photo_id: UUID) -> Response:
        group = _managed_group_or_404(request, group_id)
        project = selectors.get_group_portfolio_project_or_404(group, project_id)
        photo = selectors.get_group_portfolio_photo_or_404(project, photo_id)
        try:
            services.set_primary_group_portfolio_photo(project, cast(User, request.user), photo)
        except services.GroupPermissionDeniedError as exc:
            raise _group_permission_denied(exc) from exc
        project.refresh_from_db()
        return Response(GroupPortfolioProjectSerializer(project).data)
