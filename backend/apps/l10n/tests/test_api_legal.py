"""GET /v1/legal/<doc> (docs/tasks/Задача_feat_l10n-launch-surfaces.md §B,
✅ приёмка) — публичный эндпоинт: юр-документ платформы на языке
пользователя + оговорка об основной версии + честный признак фолбэка."""

from __future__ import annotations

import pytest
from rest_framework.test import APIClient

from apps.l10n import services

pytestmark = pytest.mark.django_db

_EN_PRIVACY = "# Privacy Policy\n\n## 1. The idea\n\nWe store as little as possible.\n"
_EN_TERMS = "# Terms of Service\n\n## 1. Who runs this Service\n\nOne person.\n"
_EN_NOTICE = "This English text is the authoritative version of this document."

_ES_PRIVACY = "# Política de privacidad\n\n## 1. La idea\n\nGuardamos lo mínimo.\n"
_ES_NOTICE = "Traducción automática por comodidad; prevalece la versión inglesa."


def _import_en() -> None:
    services.import_pack(
        {
            "locale": "en",
            "name": "English",
            "rtl": False,
            "quality": "canonical",
            "pack_version": 1,
            "legal": {
                "privacy": _EN_PRIVACY,
                "tos": _EN_TERMS,
                "document_notice": _EN_NOTICE,
            },
        }
    )


def _import_es(*, with_privacy: bool = True) -> None:
    legal: dict[str, str | None] = {"document_notice": _ES_NOTICE}
    if with_privacy:
        legal["privacy"] = _ES_PRIVACY
    services.import_pack(
        {
            "locale": "es",
            "name": "Español",
            "rtl": False,
            "quality": "machine",
            "pack_version": 1,
            "legal": legal,
        }
    )


def test_legal_endpoint_is_public():
    _import_en()
    resp = APIClient().get("/v1/legal/privacy")
    assert resp.status_code == 200


def test_returns_document_in_requested_locale_with_notice_and_machine_quality():
    _import_en()
    _import_es()

    resp = APIClient().get("/v1/legal/privacy?locale=es")

    assert resp.status_code == 200
    assert resp.data == {
        "doc": "privacy",
        "locale": "es",
        "requested_locale": "es",
        "authoritative_locale": "en",
        "quality": "machine",
        "notice": _ES_NOTICE,
        "body": _ES_PRIVACY,
    }


def test_terms_slug_maps_to_tos_pack_key():
    """Слаг URL — по имени документа, ключ пакета исторический (`tos`):
    соответствие держит LEGAL_DOC_KEYS, и оно обязано работать."""
    _import_en()

    resp = APIClient().get("/v1/legal/terms?locale=en")

    assert resp.status_code == 200
    assert resp.data["body"] == _EN_TERMS


def test_canonical_locale_is_marked_human_not_machine():
    _import_en()

    resp = APIClient().get("/v1/legal/privacy?locale=en")

    assert resp.data["quality"] == "human"
    assert resp.data["locale"] == "en"


def test_fallback_to_en_is_reported_honestly():
    """Правило §0 («каждое слово на языке пользователя») требует, чтобы фронт
    МОГ отличить документ на языке пользователя от английского фолбэка —
    иначе интерфейс покажет английский текст, утверждая, что он переведён."""
    _import_en()
    _import_es(with_privacy=False)

    resp = APIClient().get("/v1/legal/privacy?locale=es")

    assert resp.status_code == 200
    assert resp.data["requested_locale"] == "es"
    assert resp.data["locale"] == "en"
    assert resp.data["body"] == _EN_PRIVACY
    # Оговорка — из ТОГО ЖЕ пакета, что тело: разноязычная пара «английский
    # текст + испанская оговорка» хуже отсутствия оговорки.
    assert resp.data["notice"] == _EN_NOTICE
    assert resp.data["quality"] == "human"


def test_unknown_locale_falls_back_to_en():
    _import_en()

    resp = APIClient().get("/v1/legal/privacy?locale=xx")

    assert resp.status_code == 200
    assert resp.data["locale"] == "en"


def test_unknown_doc_slug_is_404():
    _import_en()

    resp = APIClient().get("/v1/legal/cookies?locale=en")

    assert resp.status_code == 404
    assert resp.data["code"] == "not_found"


def test_document_not_yet_published_is_404_with_its_own_code():
    """`legal.privacy` = null во всех пакетах (состояние до влития юр-текста,
    l10n/merge_legal.py) — отдельный код, не общий not_found: «такого
    документа не бывает» и «этот документ ещё не опубликован» — разные факты."""
    services.import_pack(
        {
            "locale": "en",
            "name": "English",
            "rtl": False,
            "quality": "canonical",
            "pack_version": 1,
            "legal": {"privacy": None, "tos": None},
        }
    )

    resp = APIClient().get("/v1/legal/privacy?locale=en")

    assert resp.status_code == 404
    assert resp.data["code"] == "legal_document_not_published"


def test_notice_absent_in_pack_is_null_not_an_error():
    services.import_pack(
        {
            "locale": "en",
            "name": "English",
            "rtl": False,
            "quality": "canonical",
            "pack_version": 1,
            "legal": {"privacy": _EN_PRIVACY},
        }
    )

    resp = APIClient().get("/v1/legal/privacy?locale=en")

    assert resp.status_code == 200
    assert resp.data["notice"] is None


def test_locale_query_param_wins_over_accept_language():
    """`?locale=` — активный язык переключателя; Accept-Language — лишь
    подсказка браузера, и она огрубляет регион-тэгированные коды
    (common.i18n: `pt-BR` → `pt`), поэтому документ берёт параметр."""
    _import_en()
    _import_es()

    resp = APIClient().get("/v1/legal/privacy?locale=es", HTTP_ACCEPT_LANGUAGE="en-US,en;q=0.9")

    assert resp.data["locale"] == "es"
