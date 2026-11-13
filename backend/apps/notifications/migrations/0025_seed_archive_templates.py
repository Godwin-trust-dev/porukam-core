"""ADR-139: доказательный пакет сделки (apps.archive) — шаблон `archive.ready`
(«архив готов», обеим сторонам, прямым вызовом place_notification из
apps.archive.services с юрзначимым письмом-вложением, не через реестр
топиков — см. докстринг NOTIFICATION_TOPIC_TEMPLATES про contract.completed).

Тот же приём, что 0017-0019: `body_i18n` ПУСТОЙ, текст — из языкового
пакета (`notifications.archive.ready`, долито во все 29 пакетов патчем
`l10n/patches/adr-139-archive.json`). `legal_significance=True`: выдача
архива обеим сторонам — условие схемы ADR-137, а не сервисная рассылка."""

from __future__ import annotations

from django.db import migrations

TEMPLATES: dict[str, bool] = {
    "archive.ready": True,
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
    dependencies = [("notifications", "0024_seed_evidence_retention_templates")]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
