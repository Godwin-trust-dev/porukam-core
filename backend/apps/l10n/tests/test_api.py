"""GET /v1/locales (Л.2 п.1, ✅ приёмка) — публичный эндпоинт, активные
языки с качеством для бейджа beta."""

from __future__ import annotations

import pytest
from rest_framework.test import APIClient

from apps.l10n import services
from apps.l10n.models import Locale

pytestmark = pytest.mark.django_db


def test_locales_endpoint_is_public():
    client = APIClient()
    resp = client.get("/v1/locales")
    assert resp.status_code == 200


def test_locales_endpoint_returns_seed_locales_with_quality():
    client = APIClient()
    resp = client.get("/v1/locales")

    by_code = {row["code"]: row for row in resp.data}
    # canonical (en) и reviewed (ru) — обе "готовые" для фронта, сводятся в
    # бинарное quality: 'human' (LocaleInfo, packages/core/src/api/types.ts) —
    # бейдж beta только для machine.
    assert by_code["en"]["quality"] == "human"
    assert by_code["ru"]["quality"] == "human"


def test_locales_endpoint_matches_frontend_locale_info_shape():
    """docs/tasks/Задача_fix_web-locales-switcher.md — шейп ДОЛЖЕН совпадать
    с LocaleInfo (packages/core/src/api/types.ts), иначе фронт получает
    undefined на self_name/enabled и либо падает (LocaleList.sort по
    self_name.localeCompare), либо считает ВСЕ языки выключенными
    (useLocaleResolution: locales.filter(l => l.enabled))."""
    client = APIClient()
    resp = client.get("/v1/locales")

    by_code = {row["code"]: row for row in resp.data}
    assert by_code["en"] == {
        "code": "en",
        "self_name": "English",
        "english_name": "English",
        "quality": "human",
        "enabled": True,
        "dir": "ltr",
    }
    assert by_code["ru"] == {
        "code": "ru",
        "self_name": "Русский",
        "english_name": "Russian",
        "quality": "human",
        "enabled": True,
        "dir": "ltr",
    }


def test_locales_endpoint_marks_machine_quality_for_beta_badge():
    services.import_pack(
        {
            "locale": "es",
            "name": "Español",
            "rtl": False,
            "quality": "machine",
            "pack_version": 1,
        }
    )
    client = APIClient()
    resp = client.get("/v1/locales")

    by_code = {row["code"]: row for row in resp.data}
    assert by_code["es"]["quality"] == "machine"


def test_locales_endpoint_excludes_disabled_locale():
    services.import_pack(
        {
            "locale": "es",
            "name": "Español",
            "rtl": False,
            "quality": "machine",
            "pack_version": 1,
        }
    )
    Locale.objects.filter(code="es").update(enabled=False)

    client = APIClient()
    resp = client.get("/v1/locales")

    assert "es" not in {row["code"] for row in resp.data}
