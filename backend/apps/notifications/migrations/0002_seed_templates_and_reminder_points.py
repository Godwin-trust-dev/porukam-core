"""Сид шаблонов-болванок и серий напоминаний (docs/tasks/fundament.md ЭФ.4).

`entity_claimed` — привязан к settings.NOTIFICATION_TOPIC_TEMPLATES
("entity.claimed" -> "entity_claimed") и уже работающему потоку
apps.entities.services._apply_claim, поэтому приёмочный сценарий ЭФ.4
(«claim юрлица -> GET /notifications») использует реальное событие, не
синтетическое.

`milestone_acceptance` — серия напоминаний по точкам (domain-model.md §17:
0/50/75/90/99%) для kind, уже сконфигурированного в apps.deadlines
(DeadlineKindConfig, ЭФ.2, docs/tasks/etap-3.md) под окно приёмки этапа;
обработчик самой приёмки — этап 4 (fundament.md «Чего НЕ делать»), здесь —
только механизм серии, текст — болванка."""

from __future__ import annotations

from django.db import migrations

TEMPLATES = {
    "entity_claimed": {
        "legal_significance": False,
        "body_stub": "Подтверждён контроль над юрлицом.",
    },
    "milestone_acceptance_reminder": {
        "legal_significance": True,
        "body_stub": "Напоминание об истекающем окне приёмки этапа.",
    },
}

REMINDER_POINTS = {
    "milestone_acceptance": {
        "template": "milestone_acceptance_reminder",
        "points": [0.0, 0.5, 0.75, 0.9, 0.99],
    },
}


def seed(apps, schema_editor):
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    for code, fields in TEMPLATES.items():
        NotificationTemplate.objects.update_or_create(code=code, defaults=fields)

    ReminderPointConfig = apps.get_model("notifications", "ReminderPointConfig")
    for kind, fields in REMINDER_POINTS.items():
        ReminderPointConfig.objects.update_or_create(kind=kind, defaults=fields)


def unseed(apps, schema_editor):
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    NotificationTemplate.objects.filter(code__in=TEMPLATES).delete()

    ReminderPointConfig = apps.get_model("notifications", "ReminderPointConfig")
    ReminderPointConfig.objects.filter(kind__in=REMINDER_POINTS).delete()


class Migration(migrations.Migration):

    dependencies = [("notifications", "0001_initial")]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
