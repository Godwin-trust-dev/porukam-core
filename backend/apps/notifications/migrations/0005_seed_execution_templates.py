"""Сид шаблонов-болванок Э4.6 (docs/tasks/etap-4.md): исполнение договора.

`milestone_submitted_for_acceptance` — размещается `apps.milestones.
services.submit_milestone` в момент якорения дедлайна приёмки (точка 0.0
серии напоминаний, уже сконфигурированной ReminderPointConfig(kind=
"milestone_acceptance"), миграция 0002 — здесь только сам шаблон уведомления
о старте окна, «усиленная серия» ЭФ.4 текстов не меняет). `milestone_
material_notice` — уведомление контрагента об уведомлении-заглушке проблемы
с материалами (ADR-019)."""

from __future__ import annotations

from django.db import migrations

TEMPLATES = {
    "milestone_submitted_for_acceptance": {
        "ru": "Этап сдан на приёмку — начался отсчёт окна приёмки.",
        "en": "The milestone has been submitted for acceptance — the acceptance window has started.",
    },
    "milestone_material_notice": {
        "ru": "Контрагент сообщил о проблеме с материалами по этапу.",
        "en": "The counterparty reported a materials issue on the milestone.",
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
    dependencies = [("notifications", "0004_seed_en_body_i18n")]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
