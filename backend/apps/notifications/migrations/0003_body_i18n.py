"""ГВ.5 (docs/tasks/global-wave.md, ADR-075): body_stub (одноязычный) →
body_i18n ({"ru": ..., "en": ...}) — язык уведомления резолвится
per-получатель, не хранится статично на шаблоне (см. docstring модели).

AddField → перенос данных → RemoveField в одной миграции, порядок важен:
на момент RunPython модель уже имеет ОБА поля (state после AddField, до
RemoveField), иначе перенести body_stub было бы неоткуда."""

from django.db import migrations, models


def copy_body_stub_to_i18n(apps, schema_editor):
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    for template in NotificationTemplate.objects.all():
        template.body_i18n = {"ru": template.body_stub} if template.body_stub else {}
        template.save(update_fields=["body_i18n"])


def copy_body_i18n_to_stub(apps, schema_editor):
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    for template in NotificationTemplate.objects.all():
        template.body_stub = template.body_i18n.get("ru", "")
        template.save(update_fields=["body_stub"])


class Migration(migrations.Migration):
    dependencies = [
        ("notifications", "0002_seed_templates_and_reminder_points"),
    ]

    operations = [
        migrations.AddField(
            model_name="notificationtemplate",
            name="body_i18n",
            field=models.JSONField(default=dict),
        ),
        migrations.RunPython(copy_body_stub_to_i18n, copy_body_i18n_to_stub),
        migrations.RemoveField(
            model_name="notificationtemplate",
            name="body_stub",
        ),
    ]
