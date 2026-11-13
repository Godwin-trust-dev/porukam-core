"""ADR-133 (подтверждение гарантийной претензии заказчиком +
автоподтверждение): строки `NotificationTemplate` для топиков
`warranty.fix_submitted` («устранил»), `warranty.claim_satisfied`
(заказчик подтвердил), `warranty.claim_contested` («не устранено»),
`warranty.claim_auto_satisfied` (окно подтверждения истекло молча).

Тот же приём, что 0017/0018: `body_i18n` ПУСТОЙ, текст — из языкового
пакета (`notifications.<code>`, долито во все 29 пакетов патчем
`l10n/patches/adr-133-warranty-satisfaction.json`). Все четыре —
`legal_significance=True`: «устранил» открывает окно, от которого считается
автоподтверждение; остальные три — исход/возражение по претензии."""

from __future__ import annotations

from django.db import migrations

TEMPLATES: dict[str, bool] = {
    "warranty.fix_submitted": True,
    "warranty.claim_satisfied": True,
    "warranty.claim_contested": True,
    "warranty.claim_auto_satisfied": True,
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
    dependencies = [("notifications", "0019_seed_amendment_closed_templates")]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
