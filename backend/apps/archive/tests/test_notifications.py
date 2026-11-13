"""Шаблон `archive.ready` (notifications/0025) — текст из настоящих
языковых пакетов (`l10n/patches/adr-139-archive.json` -> 29 паков), группа
ленты `deals` (тип `archive_ready`), юрзначимость."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from django.conf import settings

from apps.l10n import services as l10n_services
from apps.notifications import selectors as notification_selectors
from apps.notifications.models import NotificationTemplate

pytestmark = pytest.mark.django_db

_PACKS_DIR = Path(settings.BASE_DIR).parent / "l10n" / "packs"


def test_archive_ready_template_seeded_and_renders_from_packs():
    template = NotificationTemplate.objects.get(code="archive.ready")
    assert template.legal_significance is True
    for code in ("ru", "en", "de", "zh-Hans"):
        l10n_services.import_pack(json.loads((_PACKS_DIR / f"{code}.json").read_text("utf-8")))
    ru = notification_selectors.render_body("archive.ready", locale="ru")
    en = notification_selectors.render_body("archive.ready", locale="en")
    assert "{contract_title}" in ru and "хеш" in ru
    assert "{contract_title}" in en and "hash" in en
    assert notification_selectors.render_subject("archive.ready", locale="de")
    assert notification_selectors.channel_group_for_template("archive.ready") == "deals"


def test_every_pack_has_archive_ready_text():
    for path in sorted(_PACKS_DIR.glob("*.json")):
        data = json.loads(path.read_text("utf-8"))
        entry = data["notifications"]["archive.ready"]
        assert entry["subject"] and "{contract_title}" in entry["body"], path.name
