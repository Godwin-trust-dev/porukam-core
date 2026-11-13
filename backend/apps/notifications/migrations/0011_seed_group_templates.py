"""Шаблоны уведомлений объединений (отсмотр 2026-08-23): заявка на
вступление (лидеру), приглашение (приглашённому), заявка одобрена
(заявителю). Код = топик, текст — из языкового пакета (l10n, namespace
`notifications.<topic>`), body_i18n пуст — тот же приём, что 0007."""

from __future__ import annotations

from django.db import migrations

GROUP_TEMPLATES = ("group.join_requested", "group.invited", "group.request_approved")


def seed(apps, schema_editor):
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    for code in GROUP_TEMPLATES:
        NotificationTemplate.objects.update_or_create(
            code=code, defaults={"legal_significance": False, "body_i18n": {}}
        )


def unseed(apps, schema_editor):
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    NotificationTemplate.objects.filter(code__in=GROUP_TEMPLATES).delete()


class Migration(migrations.Migration):
    dependencies = [("notifications", "0010_pushsubscription")]

    operations = [migrations.RunPython(seed, unseed)]
