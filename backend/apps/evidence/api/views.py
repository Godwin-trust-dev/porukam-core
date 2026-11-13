from __future__ import annotations

from typing import Any, cast
from uuid import UUID

from django.conf import settings as django_settings
from django.http import HttpResponse
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import User
from apps.accounts.providers import build_drive_oauth_provider
from apps.contracts import services as contracts_services
from apps.disputes import selectors as disputes_selectors
from apps.milestones import selectors as milestones_selectors
from common.api.exceptions import DomainAPIError

from .. import selectors, services
from ..models import Evidence
from ..providers import (
    FakeGoogleDriveBackupProvider,
    GoogleDriveBackupProvider,
    RealGoogleDriveBackupProvider,
)
from .serializers import (
    EvidenceSerializer,
    EvidenceUploadSerializer,
    EvidenceVerifyResultSerializer,
    EvidenceVerifySerializer,
    RetentionPolicySerializer,
)


def _drive_provider() -> GoogleDriveBackupProvider:
    """Тумблер fake/real — `settings.EVIDENCE_DRIVE_PROVIDER` (ADR-084,
    docs/tasks/Задача_feat_evidence-drive.md §2.4): прод = real, тесты/
    локалка = fake (дефолт настройки). Читается на каждый запрос, не на
    импорт модуля — override_settings в тестах должен работать
    предсказуемо, тот же приём, что apps.accounts.api.views."""
    if django_settings.EVIDENCE_DRIVE_PROVIDER == "real":
        return RealGoogleDriveBackupProvider(oauth_provider=build_drive_oauth_provider())
    return FakeGoogleDriveBackupProvider()


_SERVICE_ERROR_STATUS: dict[type[Exception], tuple[int, str, str]] = {
    contracts_services.NotAPartyError: (
        status.HTTP_403_FORBIDDEN,
        "permission_denied",
        "Вы не сторона этого договора",
    ),
    services.EvidenceNotAttachedError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "evidence_not_attached",
        "Доказательство должно быть привязано к этапу или спору",
    ),
    services.ChecklistItemNotOnMilestoneError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "checklist_item_wrong_milestone",
        "Пункт чек-листа принадлежит другому этапу",
    ),
    services.EvidenceTooLargeError: (
        status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
        "evidence_too_large",
        "Файл превышает допустимый размер",
    ),
    services.EvidenceUploadRateLimitedError: (
        status.HTTP_429_TOO_MANY_REQUESTS,
        "evidence_upload_rate_limited",
        "Превышена частота загрузок доказательств",
    ),
    services.EvidenceOriginalUnavailableError: (
        status.HTTP_409_CONFLICT,
        "evidence_original_unavailable",
        "Оригинал уже удалён после подтверждённой доставки",
    ),
    # ADR-136 (Э6).
    services.EvidenceOriginalShreddedError: (
        status.HTTP_409_CONFLICT,
        "evidence_original_shredded",
        "Оригинал уничтожен по сроку хранения; хеш и миниатюра сохранены",
    ),
    services.DeviceManifestDisabledError: (
        status.HTTP_409_CONFLICT,
        "device_manifest_disabled",
        "Приём подписанных манифестов устройства ещё не включён",
    ),
    services.DeviceManifestInvalidError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "device_manifest_invalid",
        "Манифест устройства не прошёл проверку",
    ),
    services.AssignmentNotValidError: (
        status.HTTP_403_FORBIDDEN,
        "assignment_not_valid",
        "Назначение на договор не действовало в момент съёмки",
    ),
}


def _call_service(fn: Any, *args: Any, **kwargs: Any) -> Any:  # noqa: ANN401
    try:
        return fn(*args, **kwargs)
    except tuple(_SERVICE_ERROR_STATUS) as exc:
        status_code, code, title = _SERVICE_ERROR_STATUS[type(exc)]
        raise DomainAPIError(
            status_code=status_code, code=code, title=title, detail=str(exc)
        ) from exc


def _get_evidence_as_party(request: Request, evidence_id: UUID) -> Evidence:
    evidence = selectors.get_evidence_or_404(evidence_id)
    if not contracts_services.is_party(evidence.contract, cast(User, request.user)):
        raise DomainAPIError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="permission_denied",
            title="Вы не сторона этого договора",
        )
    return evidence


class MilestoneEvidenceListCreateView(APIView):
    """GET/POST /milestones/{id}/evidence — тот же URL, что etap-4.md Э4.6
    (`apps.documents`, файлы-заглушки); теперь настоящий контур ГВ.3.
    Заменяет старую реализацию БЕЗ смены адреса — клиенты не меняются."""

    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]

    @extend_schema(responses={200: EvidenceSerializer(many=True)})
    def get(self, request: Request, milestone_id: UUID) -> Response:
        milestone = milestones_selectors.get_milestone_or_404(milestone_id)
        if not contracts_services.is_party(milestone.contract, cast(User, request.user)):
            raise DomainAPIError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="permission_denied",
                title="Вы не сторона этого договора",
            )
        return Response(
            EvidenceSerializer(selectors.list_for_milestone(milestone_id), many=True).data
        )

    @extend_schema(request=EvidenceUploadSerializer, responses={201: EvidenceSerializer})
    def post(self, request: Request, milestone_id: UUID) -> Response:
        milestone = milestones_selectors.get_milestone_or_404(milestone_id)
        serializer = EvidenceUploadSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        upload = serializer.validated_data["file"]
        checklist_item_id = request.data.get("checklist_item_id") or None
        evidence = _call_service(
            services.upload_evidence,
            milestone.contract,
            user=cast(User, request.user),
            content=upload.read(),
            file_name=upload.name,
            mime_type=upload.content_type or "application/octet-stream",
            description=serializer.validated_data.get("description", ""),
            milestone_id=milestone_id,
            checklist_item_id=UUID(checklist_item_id) if checklist_item_id else None,
            device_manifest=serializer.validated_data.get("manifest"),
            device_signature=serializer.validated_data.get("signature"),
        )
        return Response(EvidenceSerializer(evidence).data, status=status.HTTP_201_CREATED)


class DisputeEvidenceListCreateView(APIView):
    """GET/POST /disputes/{id}/evidence — вне таблицы tech-spec.md §8.8
    (появилась только с ГВ.3): контрдоказательства в рамках разногласия.

    Договор берём из `dispute.contract`, а не из `dispute.milestone.contract`:
    с этапа 7 (ADR-131) этап у спора может отсутствовать вовсе —
    у гарантийного разногласия (`kind=warranty`) оспаривается результат
    договора целиком, а не конкретный лист."""

    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]

    @extend_schema(responses={200: EvidenceSerializer(many=True)})
    def get(self, request: Request, dispute_id: UUID) -> Response:
        dispute = disputes_selectors.get_dispute_or_404(dispute_id)
        if not contracts_services.is_party(dispute.contract, cast(User, request.user)):
            raise DomainAPIError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="permission_denied",
                title="Вы не сторона этого договора",
            )
        return Response(EvidenceSerializer(selectors.list_for_dispute(dispute_id), many=True).data)

    @extend_schema(request=EvidenceUploadSerializer, responses={201: EvidenceSerializer})
    def post(self, request: Request, dispute_id: UUID) -> Response:
        dispute = disputes_selectors.get_dispute_or_404(dispute_id)
        serializer = EvidenceUploadSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        upload = serializer.validated_data["file"]
        evidence = _call_service(
            services.upload_evidence,
            dispute.contract,
            user=cast(User, request.user),
            content=upload.read(),
            file_name=upload.name,
            mime_type=upload.content_type or "application/octet-stream",
            description=serializer.validated_data.get("description", ""),
            dispute_id=dispute_id,
            device_manifest=serializer.validated_data.get("manifest"),
            device_signature=serializer.validated_data.get("signature"),
        )
        return Response(EvidenceSerializer(evidence).data, status=status.HTTP_201_CREATED)


class EvidenceDetailView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: EvidenceSerializer})
    def get(self, request: Request, evidence_id: UUID) -> Response:
        evidence = _get_evidence_as_party(request, evidence_id)
        return Response(EvidenceSerializer(evidence).data)


class EvidenceThumbnailView(APIView):
    """GET /evidence/{id}/thumbnail — байты миниатюры (встроенное EXIF-
    превью камеры, ГВ.3 п.2); `404` — миниатюры нет (не у каждого файла
    она встроена, честно, не подделывается)."""

    permission_classes = [IsAuthenticated]

    def get(self, request: Request, evidence_id: UUID) -> HttpResponse:
        evidence = _get_evidence_as_party(request, evidence_id)
        if evidence.thumbnail is None:
            raise DomainAPIError(
                status_code=status.HTTP_404_NOT_FOUND,
                code="thumbnail_not_available",
                title="У этого файла нет встроенной миниатюры",
            )
        return HttpResponse(bytes(evidence.thumbnail), content_type="image/jpeg")


class EvidenceDownloadView(APIView):
    """GET /evidence/{id}/download (ГВ.3 п.1: «доставка через... скачивание,
    пока файл в транзите»)."""

    permission_classes = [IsAuthenticated]

    def get(self, request: Request, evidence_id: UUID) -> HttpResponse:
        evidence = _get_evidence_as_party(request, evidence_id)
        content = _call_service(services.download_original, evidence, user=cast(User, request.user))
        response = HttpResponse(content, content_type=evidence.mime_type)
        response["Content-Disposition"] = f'attachment; filename="{evidence.file_name}"'
        return response


class EvidenceVerifyView(APIView):
    """POST /evidence/{id}/verify (ГВ.3 п.2: «эндпоинт сверить предъявленный
    файл с хешом»)."""

    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]

    @extend_schema(
        request=EvidenceVerifySerializer, responses={200: EvidenceVerifyResultSerializer}
    )
    def post(self, request: Request, evidence_id: UUID) -> Response:
        evidence = _get_evidence_as_party(request, evidence_id)
        serializer = EvidenceVerifySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        upload = serializer.validated_data["file"]
        matches = _call_service(
            services.verify_hash,
            evidence,
            presented_content=upload.read(),
            user=cast(User, request.user),
        )
        return Response(EvidenceVerifyResultSerializer({"matches": matches}).data)


class EvidenceBackupView(APIView):
    """POST /evidence/{id}/backup (ГВ.3 п.3): BYO-бэкап в Google Drive —
    статус виден на самой карточке доказательства, отказ НЕ поднимает
    ошибку (200 с `backup_status=failed` + причина, не 5xx)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=None, responses={200: EvidenceSerializer})
    def post(self, request: Request, evidence_id: UUID) -> Response:
        evidence = _get_evidence_as_party(request, evidence_id)
        evidence = _call_service(
            services.request_backup,
            evidence,
            user=cast(User, request.user),
            provider=_drive_provider(),
        )
        return Response(EvidenceSerializer(evidence).data)


class RetentionPolicyView(APIView):
    """GET /evidence/retention-policy — публичная (без авторизации) политика
    хранения (ADR-137 требование 9): фронт показывает сроки при создании
    сделки. Значения — из DeadlineKindConfig (данные), меняются без релиза;
    кэшируется на краю (Cloudflare) и в браузере — это не ПД и не состояние
    пользователя."""

    permission_classes = [AllowAny]
    authentication_classes: list[Any] = []

    @extend_schema(responses={200: RetentionPolicySerializer})
    def get(self, request: Request) -> Response:
        response = Response(RetentionPolicySerializer(selectors.retention_policy()).data)
        response["Cache-Control"] = (
            f"public, max-age={django_settings.EVIDENCE_RETENTION_POLICY_CACHE_SECONDS}"
        )
        return response
