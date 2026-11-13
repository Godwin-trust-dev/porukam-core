"""Э6 (ADR-136): RetentionTimer доказательств (ADR-036) — три строки
`NotificationTemplate` под системные события свипа (actor пуст -> обеим
сторонам через NOTIFICATION_TOPIC_COUNTERPARTY_TEMPLATES):
`evidence.retention_expiring` («скачайте себе» за 10 дней до срока),
`evidence.archived`, `evidence.shredded`.

Тот же приём, что 0017/0018: `body_i18n` ПУСТОЙ, текст — из языкового
пакета (`notifications.<topic>`, долито во все 29 пакетов патчем
`l10n/patches/adr-136-evidence-retention.json`). `legal_significance=True`:
это уведомления о судьбе доказательной базы стороны (оферта, ADR-036)."""

from __future__ import annotations

from django.db import migrations

TEMPLATES: dict[str, bool] = {
    "evidence.retention_expiring": True,
    "evidence.archived": True,
    "evidence.shredded": True,
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
    dependencies = [("notifications", "0023_seed_idle_autoclose_templates")]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
