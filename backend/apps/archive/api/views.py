from __future__ import annotations

from typing import Any, cast
from uuid import UUID

from django.conf import settings as django_settings
from django.http import HttpRequest, HttpResponse, JsonResponse
from django.utils import timezone
from django.views.decorators.http import require_GET
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import User
from apps.contracts import selectors as contracts_selectors
from apps.contracts import services as contracts_services
from common.api import idempotency
from common.api.exceptions import DomainAPIError
from common.net import client_ip

from .. import selectors, services
from ..models import ArchiveExport, ArchiveLink
from .serializers import (
    ArchiveLinkSerializer,
    ArchivePreviewSerializer,
    ExportAcceptedSerializer,
    ExportJobSerializer,
    ExportOptionsSerializer,
)

_SERVICE_ERROR_STATUS: dict[type[Exception], tuple[int, str, str]] = {
    contracts_services.NotAPartyError: (
        status.HTTP_403_FORBIDDEN,
        "permission_denied",
        "Вы не сторона этого договора",
    ),
    services.NothingToExportError: (
        status.HTTP_409_CONFLICT,
        "archive_nothing_to_export",
        "Пока нечего собирать: договор ни разу не заморожен",
    ),
    services.ExportOptionsConflictError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "archive_options_conflict",
        "include_originals и manifest_only взаимоисключающие",
    ),
    services.ExportNotReadyError: (
        status.HTTP_409_CONFLICT,
        "archive_export_not_ready",
        "Архив ещё не собран",
    ),
    idempotency.IdempotencyKeyRequiredError: (
        status.HTTP_400_BAD_REQUEST,
        "idempotency_key_required",
        "Заголовок Idempotency-Key обязателен",
    ),
    idempotency.IdempotencyKeyReusedError: (
        status.HTTP_409_CONFLICT,
        "idempotency_key_reused",
        "Idempotency-Key уже использован с другим телом запроса",
    ),
}

_PROGRESS = {
    ArchiveExport.Status.QUEUED: 0,
    ArchiveExport.Status.RUNNING: 50,
    ArchiveExport.Status.READY: 100,
    ArchiveExport.Status.FAILED: 100,
}

IDEMPOTENCY_ENDPOINT = "archive.export"


def _call_service(fn: Any, *args: Any, **kwargs: Any) -> Any:  # noqa: ANN401
    try:
        return fn(*args, **kwargs)
    except tuple(_SERVICE_ERROR_STATUS) as exc:
        status_code, code, title = _SERVICE_ERROR_STATUS[type(exc)]
        raise DomainAPIError(
            status_code=status_code, code=code, title=title, detail=str(exc)
        ) from exc


def _contract_as_party(request: Request, contract_id: UUID) -> Any:  # noqa: ANN401
    contract = contracts_selectors.get_contract_or_404(contract_id)
    if not contracts_services.is_party(contract, cast(User, request.user)):
        raise DomainAPIError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="permission_denied",
            title="Вы не сторона этого договора",
        )
    return contract


def _my_role(contract: Any, user: User) -> str | None:  # noqa: ANN401
    try:
        return str(contracts_services.get_party_for_user(contract, user).role)
    except contracts_services.NotAPartyError:
        return None


def _link_view(link: ArchiveLink, *, show_token: bool) -> dict[str, Any]:
    token = services.link_token_for_party(link) if show_token else None
    return {
        "id": link.id,
        "kind": link.kind,
        "party_role": link.party_role,
        "url": services.link_url(token) if token else None,
        "created_at": link.created_at,
        "revoked_at": link.revoked_at,
        "last_access_at": link.last_access_at,
        "access_count": link.access_count,
    }


def export_view(export: ArchiveExport, *, role: str | None) -> dict[str, Any]:
    """Представление экспорта ДЛЯ СТОРОНЫ: ссылки — только её (`url` у чужой
    стороны null, симметрия состава при этом сохраняется)."""
    links = list(export.links.order_by("created_at"))
    mine = {
        link.kind: link for link in links if link.party_role == role and link.revoked_at is None
    }

    def _artifact(
        kind: str, *, size: int | None, sha256: str, state: str, expires_at: Any, shredded_at: Any
    ) -> dict[str, Any] | None:  # noqa: ANN401
        if export.status != ArchiveExport.Status.READY:
            return None
        link = mine.get(kind)
        token = services.link_token_for_party(link) if link is not None else None
        return {
            "url": services.link_url(token) if token else None,
            "size_bytes": size,
            "sha256": sha256 or None,
            "state": state,
            "expires_at": expires_at,
            "shredded_at": shredded_at,
        }

    package = _artifact(
        ArchiveLink.Kind.PACKAGE,
        size=export.package_size,
        sha256=export.package_sha256,
        state="available",
        expires_at=None,
        shredded_at=None,
    )
    files = (
        _artifact(
            ArchiveLink.Kind.FILES,
            size=export.files_size,
            sha256=export.files_sha256,
            state=export.files_state,
            expires_at=export.files_expires_at,
            shredded_at=export.files_shredded_at,
        )
        if export.files_state != ArchiveExport.FilesState.NOT_REQUESTED
        else None
    )
    return {
        "id": export.id,
        "export_id": export.id,
        "contract_id": export.contract_id,
        "status": export.status,
        "progress": _PROGRESS[ArchiveExport.Status(export.status)],
        "trigger": export.trigger,
        "is_snapshot": export.is_snapshot,
        "snapshot_at": export.snapshot_at,
        "include_originals": export.include_originals,
        "manifest_only": export.manifest_only,
        "evidence_count": export.evidence_count,
        "package": package,
        "zip": files,
        "pdf": None,
        "expires_at": export.files_expires_at,
        "links": [_link_view(link, show_token=link.party_role == role) for link in links],
        "error": export.error,
        "created_at": export.created_at,
        "finished_at": export.finished_at,
    }


class ContractArchiveView(APIView):
    """GET /contracts/{id}/archive — превью состава + экспорты + ссылки."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: ArchivePreviewSerializer})
    def get(self, request: Request, contract_id: UUID) -> Response:
        contract = _contract_as_party(request, contract_id)
        user = cast(User, request.user)
        role = _my_role(contract, user)
        data = selectors.preview(contract, user=user)
        data["snapshot_at"] = timezone.now() if data["is_snapshot"] else None
        data["exports"] = [export_view(e, role=role) for e in selectors.list_exports(contract)]
        return Response(ArchivePreviewSerializer(data).data)


class ContractArchiveExportView(APIView):
    """POST /contracts/{id}/archive/export — 202 `{export_id, jobId, status}`.
    Idempotency-Key обязателен (денежных последствий нет, но сборка —
    тяжёлая операция; повтор с тем же ключом — тот же ответ, идущая сборка с
    теми же опциями — тот же export и без ключа)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=ExportOptionsSerializer, responses={202: ExportAcceptedSerializer})
    def post(self, request: Request, contract_id: UUID) -> Response:
        contract = _contract_as_party(request, contract_id)
        user = cast(User, request.user)
        key = _call_service(idempotency.require_idempotency_key, request)
        cached = _call_service(
            idempotency.lookup, user=user, endpoint=IDEMPOTENCY_ENDPOINT, key=key, body=request.data
        )
        if cached is not None:
            return Response(cached.body, status=cached.status_code)
        serializer = ExportOptionsSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        export = _call_service(
            services.request_export,
            contract,
            user=user,
            include_originals=serializer.validated_data["include_originals"],
            manifest_only=serializer.validated_data["manifest_only"],
        )
        body = ExportAcceptedSerializer(
            {"export_id": export.id, "jobId": export.id, "status": export.status}
        ).data
        idempotency.store(
            user=user,
            endpoint=IDEMPOTENCY_ENDPOINT,
            key=key,
            body=request.data,
            status_code=status.HTTP_202_ACCEPTED,
            response_body=body,
        )
        return Response(body, status=status.HTTP_202_ACCEPTED)


class ContractArchiveExportDetailView(APIView):
    """GET /contracts/{id}/archive/export/{export_id} — поллинг состояния."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: ExportJobSerializer})
    def get(self, request: Request, contract_id: UUID, export_id: UUID) -> Response:
        contract = _contract_as_party(request, contract_id)
        export = selectors.get_export_or_404(contract, export_id)
        role = _my_role(contract, cast(User, request.user))
        return Response(ExportJobSerializer(export_view(export, role=role)).data)


class ArchiveLinkRevokeView(APIView):
    """POST /archive/links/{id}/revoke — сторона договора отзывает ссылку."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=None, responses={200: ArchiveLinkSerializer})
    def post(self, request: Request, link_id: UUID) -> Response:
        link = selectors.get_link_or_404(link_id)
        link = _call_service(services.revoke_link, link, user=cast(User, request.user))
        return Response(ArchiveLinkSerializer(_link_view(link, show_token=False)).data)


# --- /a/<token> — без авторизации ------------------------------------------------

_NO_STORE = "private, no-store"
_FILE_NAMES = {ArchiveLink.Kind.PACKAGE: "package.zip", ArchiveLink.Kind.FILES: "files.zip"}


def _wants_html(request: HttpRequest) -> bool:
    return "text/html" in request.META.get("HTTP_ACCEPT", "")


def _problem(
    request: HttpRequest,
    *,
    status_code: int,
    code: str,
    title: str,
    extra: dict[str, Any] | None = None,
) -> HttpResponse:
    body: dict[str, Any] = {"status": status_code, "code": code, "title": title, **(extra or {})}
    if _wants_html(request):
        from html import escape

        rows = "".join(
            f"<p><b>{escape(str(k))}</b>: {escape(str(v))}</p>"
            for k, v in (extra or {}).items()
            if k != "sha256sums"
        )
        sums = escape(str((extra or {}).get("sha256sums") or ""))
        html = (
            '<!doctype html><html lang="ru"><head><meta charset="utf-8">'
            f"<title>{escape(title)}</title></head>"
            '<body style="font-family:sans-serif;max-width:720px;margin:2em auto">'
            f"<h1>{escape(title)}</h1>{rows}"
            + (f"<h2>SHA256SUMS</h2><pre>{sums}</pre>" if sums else "")
            + "</body></html>"
        )
        response: HttpResponse = HttpResponse(
            html, status=status_code, content_type="text/html; charset=utf-8"
        )
    else:
        response = JsonResponse(body, status=status_code, content_type="application/problem+json")
    response["Cache-Control"] = _NO_STORE
    return response


@require_GET
def archive_link_view(request: HttpRequest, token: str) -> HttpResponse:
    """GET /a/<token> (ADR-137 «Долгоживущие ссылки», ADR-139 п.4): без
    авторизации; рейт-лимит по адресу; `Cache-Control: private, no-store`
    (иначе край Cloudflare переживёт удаление данных — треб. 11); поток
    расшифрованного zip (presigned-ссылок на шифротекст не бывает).
    После удаления файлов — 410 с датой, ссылкой на пакет и SHA256SUMS
    («ссылка живёт дольше данных»); пакет отдаётся всегда."""
    try:
        services.check_link_rate_limit(client_ip(request))
    except services.ArchiveLinkRateLimitedError:
        response = _problem(
            request,
            status_code=429,
            code="archive_link_rate_limited",
            title="Слишком много обращений",
        )
        response["Retry-After"] = str(django_settings.ARCHIVE_LINK_RATE_WINDOW_SECONDS)
        return response
    try:
        link = services.resolve_link(token)
    except services.ArchiveLinkNotFoundError:
        return _problem(
            request, status_code=404, code="archive_link_not_found", title="Ссылка не найдена"
        )
    except services.ArchiveLinkRevokedError:
        return _problem(
            request,
            status_code=410,
            code="archive_link_revoked",
            title="Ссылка отозвана стороной сделки",
        )
    export = link.export
    try:
        content = services.read_artifact(export, kind=link.kind)
    except services.ExportNotReadyError:
        services.record_link_access(link, outcome="not_ready")
        return _problem(
            request, status_code=409, code="archive_export_not_ready", title="Архив ещё не собран"
        )
    except services.ArchiveFilesShreddedError:
        services.record_link_access(link, outcome="shredded")
        package_link = export.links.filter(
            kind=ArchiveLink.Kind.PACKAGE, party_role=link.party_role, revoked_at__isnull=True
        ).first()
        package_token = services.link_token_for_party(package_link) if package_link else None
        return _problem(
            request,
            status_code=410,
            code="archive_files_shredded",
            title="Файлы архива удалены по истечении срока хранения",
            extra={
                "detail": (
                    "Файлы удалены "
                    f"{export.files_shredded_at.isoformat() if export.files_shredded_at else ''} "
                    "согласно политике хранения (оферта, п. о сроках хранения; ADR-137). "
                    "Хеши и метка времени доступны: доказательный пакет по ссылке ниже."
                ),
                "shredded_at": export.files_shredded_at.isoformat()
                if export.files_shredded_at
                else None,
                "files_sha256": export.files_sha256 or None,
                "package_url": services.link_url(package_token) if package_token else None,
                "package_sha256": export.package_sha256,
                "sha256sums": export.sha256sums,
                "retention_policy_url": (
                    f"{str(django_settings.ARCHIVE_LINK_BASE_URL).rstrip('/')}"
                    "/v1/evidence/retention-policy"
                ),
            },
        )
    services.record_link_access(link, outcome="ok")
    response = HttpResponse(content, content_type="application/zip")
    response["Content-Disposition"] = (
        f'attachment; filename="{_FILE_NAMES[ArchiveLink.Kind(link.kind)]}"'
    )
    response["Content-Length"] = str(len(content))
    response["Cache-Control"] = _NO_STORE
    response["X-Content-Sha256"] = (
        export.package_sha256 if link.kind == ArchiveLink.Kind.PACKAGE else export.files_sha256
    )
    return response
