"""Сид ГВ.5 (docs/tasks/global-wave.md, ADR-075): EN-болванки body_i18n для
двух существующих шаблонов (entity_claimed, milestone_acceptance_reminder)
— тексты «начисто» придут отдельным контентным пакетом (тот же принцип, что
RU body_stub изначально был болванкой, fundament.md ЭФ.4)."""

from django.db import migrations

_EN_BODIES = {
    "entity_claimed": "Control over the company has been confirmed.",
    "milestone_acceptance_reminder": "Reminder: the milestone acceptance window is closing.",
}


def seed_en(apps, schema_editor):
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    for code, en_text in _EN_BODIES.items():
        template = NotificationTemplate.objects.filter(code=code).first()
        if template is None:
            continue
        template.body_i18n = {**template.body_i18n, "en": en_text}
        template.save(update_fields=["body_i18n"])


def unseed_en(apps, schema_editor):
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    for code in _EN_BODIES:
        template = NotificationTemplate.objects.filter(code=code).first()
        if template is None:
            continue
        template.body_i18n = {k: v for k, v in template.body_i18n.items() if k != "en"}
        template.save(update_fields=["body_i18n"])


class Migration(migrations.Migration):
    dependencies = [("notifications", "0003_body_i18n")]

    operations = [
        migrations.RunPython(seed_en, unseed_en),
    ]
