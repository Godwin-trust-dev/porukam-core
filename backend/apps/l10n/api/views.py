from __future__ import annotations

from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from common.api.exceptions import DomainAPIError
from common.i18n import resolve_request_locale

from .. import selectors
from .serializers import LegalDocumentSerializer, LocaleSerializer, binary_quality


class LocaleListView(APIView):
    """GET /v1/locales (Л.2 п.1) — активные языки с качеством, чтобы фронт
    показал бейдж beta для machine до входа пользователя (выбор языка на
    экране регистрации) — публичный эндпоинт, не требует аутентификации."""

    permission_classes = [AllowAny]

    @extend_schema(responses={200: LocaleSerializer(many=True)})
    def get(self, request: Request) -> Response:
        locales = selectors.list_enabled_locales()
        return Response(LocaleSerializer(locales, many=True).data)


# Слаг документа в URL → ключ в namespace `legal` языкового пакета
# (l10n/README.md). `terms` → `tos`: слаг назван по документу («Terms of
# Service»), ключ пакета исторический — соответствие держится здесь, в одном
# месте, а не расходится по фронту и скрипту слияния.
LEGAL_DOC_KEYS = {"privacy": "privacy", "terms": "tos"}


class LegalDocumentView(APIView):
    """GET /v1/legal/<doc> — юр-документ платформы (Privacy Policy / Terms of
    Service) на языке пользователя (docs/tasks/
    Задача_feat_l10n-launch-surfaces.md §B): публичный, как /v1/locales —
    ссылки на документы висят на /welcome, то есть до всякого входа.

    Язык — из `?locale=` (явный активный язык интерфейса SPA), а не только из
    Accept-Language: заголовок браузера — подсказка по первичной подгруппе
    (`common.i18n._parse_accept_language` огрубляет `pt-BR` → `pt`), а
    документ обязан прийти РОВНО на том языке, который пользователь выбрал в
    переключателе, включая регион-тэгированные коды (`pt-BR`, `zh-Hans`).
    Без параметра — обычный `resolve_request_locale` (контур/Accept-Language)."""

    permission_classes = [AllowAny]

    @extend_schema(
        parameters=[
            OpenApiParameter(
                name="locale",
                description="Код языка документа (BCP-47, как в /v1/locales)",
                required=False,
                type=str,
            )
        ],
        responses={200: LegalDocumentSerializer},
    )
    def get(self, request: Request, doc: str) -> Response:
        key = LEGAL_DOC_KEYS.get(doc)
        if key is None:
            raise DomainAPIError(
                status_code=404,
                code="not_found",
                title="Документ не найден",
            )

        requested = request.query_params.get("locale") or resolve_request_locale(request)
        document = selectors.get_legal_document(key, locale=requested)
        if document is None:
            # Документа нет ни на запрошенном языке, ни в EN-пакете — юр-текст
            # ещё не влит (`l10n/merge_legal.py` → `import_l10n_pack`). Явный
            # код, а не общий not_found: «такого документа не бывает» и «этот
            # документ ещё не опубликован» — разные факты для фронта.
            raise DomainAPIError(
                status_code=404,
                code="legal_document_not_published",
                title="Документ пока не опубликован",
            )

        return Response(
            LegalDocumentSerializer(
                {
                    "doc": doc,
                    "locale": document.locale,
                    "requested_locale": requested,
                    "authoritative_locale": selectors.AUTHORITATIVE_LOCALE,
                    "quality": binary_quality(document.quality),
                    "notice": document.notice,
                    "body": document.body,
                }
            ).data
        )
