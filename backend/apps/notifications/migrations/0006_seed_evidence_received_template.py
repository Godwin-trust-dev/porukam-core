"""Сид шаблона ГВ.3 (docs/tasks/global-wave.md): релей контрагенту при
загрузке доказательства (apps.evidence.services.upload_evidence)."""

from __future__ import annotations

from django.db import migrations

TEMPLATES = {
    "evidence_received": {
        "ru": "Контрагент загрузил доказательство по этапу — доступно для скачивания.",
        "en": "The counterparty uploaded evidence for the milestone — available for download.",
    },
}


def seed(apps, schema_editor):
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    for code, body_i18n in TEMPLATES.items():
        NotificationTemplate.objects.update_or_create(
            code=code, defaults={"legal_significance": True, "body_i18n": body_i18n}
        )


def unseed(apps, schema_editor):
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    NotificationTemplate.objects.filter(code__in=TEMPLATES).delete()


class Migration(migrations.Migration):
    dependencies = [("notifications", "0005_seed_execution_templates")]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
