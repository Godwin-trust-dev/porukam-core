"""Хвост волны 4 (docs/backlog.md «Найдено агентами 25.08»): отказ
исполнителя по гарантийной претензии (`POST /warranty-claims/{id}/decline`,
outbox-топик `warranty.claim_declined`) — своя строка `NotificationTemplate`.

Тот же приём, что 0017: `body_i18n` ПУСТОЙ, текст — из языкового пакета
(`notifications.warranty.claim_declined`, долито во все 29 пакетов патчем
`l10n/patches/warranty-claim-declined.json`). Код нейтрален к точке зрения
(«Исполнитель отказал по претензии»), суффикса `.counterparty` нет.
`legal_significance=True`: отказ меняет правовое положение заказчика
(дальше — суд, ADR-131)."""

from __future__ import annotations

from django.db import migrations

TEMPLATES: dict[str, bool] = {
    "warranty.claim_declined": True,
}


def seed(apps, schema_editor):
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    for code, legal_significance in TEMPLATES.items():
        NotificationTemplate.objects.update_or_create(
            code=code, defaults={"legal_significance": legal_significance, "body_i18n": {}}
        )


def unseed(apps, schema_editor):
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    NotificationTemplate.objects.filter(code__in=list(TEMPLATES)).delete()


class Migration(migrations.Migration):
    dependencies = [("notifications", "0017_seed_dispute_warranty_templates")]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
