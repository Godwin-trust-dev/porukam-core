"""ADR-133, дополнение 26.08 (решение владельца в6-8 «да»): усиленная серия
напоминаний по окну подтверждения гарантийной претензии
(`DomainDeadline.kind=warranty_claim_acceptance`) — та же, что у окна
приёмки этапа.

`ReminderPointConfig(kind="warranty_claim_acceptance")` заводится со
ЗНАЧЕНИЕМ ТОЧЕК из строки `milestone_acceptance` на момент миграции (тот же
приём, что `deadlines/0007` для длительности окна), а не литералом:
источник серии — один. Шаблон `warranty_claim_acceptance_reminder` — как
0017–0020: `body_i18n` пустой, текст — из языкового пакета
(`notifications.warranty_claim_acceptance_reminder`, долито во все 29
пакетов патчем `l10n/patches/adr-133-warranty-reminders.json`);
`legal_significance=True` — напоминание о юрзначимом окне, финальная точка
серии с SMS-фоллбэком (ADR-057)."""

from __future__ import annotations

from django.db import migrations

KIND = "warranty_claim_acceptance"
SOURCE_KIND = "milestone_acceptance"
TEMPLATE = "warranty_claim_acceptance_reminder"
FALLBACK_POINTS = [0.0, 0.5, 0.75, 0.9, 0.99]


def seed(apps, schema_editor):
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    NotificationTemplate.objects.update_or_create(
        code=TEMPLATE, defaults={"legal_significance": True, "body_i18n": {}}
    )
    ReminderPointConfig = apps.get_model("notifications", "ReminderPointConfig")
    source = ReminderPointConfig.objects.filter(kind=SOURCE_KIND).first()
    points = list(source.points) if source is not None else FALLBACK_POINTS
    ReminderPointConfig.objects.update_or_create(
        kind=KIND, defaults={"template": TEMPLATE, "points": points}
    )


def unseed(apps, schema_editor):
    ReminderPointConfig = apps.get_model("notifications", "ReminderPointConfig")
    ReminderPointConfig.objects.filter(kind=KIND).delete()
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    NotificationTemplate.objects.filter(code=TEMPLATE).delete()


class Migration(migrations.Migration):
    dependencies = [("notifications", "0020_seed_warranty_satisfaction_templates")]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
