"""Сид длительности категории `signature_request_expiry` (etap-4.md Э4.4:
"SignatureRequest ... expire — истечение через deadlines"). В отличие от
0002 (значения уже зафиксированы в tech-spec.md текстом) для этой категории
явного числа в спеке НЕТ — 5 суток здесь ПРЕДМЕТ СОГЛАСОВАНИЯ С ЮРИСТОМ
(tech-spec.md §11 п.4), как и остальные строки DeadlineKindConfig; когда он
её скорректирует, это обновление строки, не правка кода."""

from datetime import timedelta

from django.db import migrations

DURATIONS = {
    "signature_request_expiry": timedelta(days=5),
}


def seed_kind_durations(apps, schema_editor):
    DeadlineKindConfig = apps.get_model("deadlines", "DeadlineKindConfig")
    for kind, duration in DURATIONS.items():
        DeadlineKindConfig.objects.update_or_create(kind=kind, defaults={"duration": duration})


def unseed_kind_durations(apps, schema_editor):
    DeadlineKindConfig = apps.get_model("deadlines", "DeadlineKindConfig")
    DeadlineKindConfig.objects.filter(kind__in=DURATIONS).delete()


class Migration(migrations.Migration):
    dependencies = [("deadlines", "0002_seed_kind_durations")]

    operations = [
        migrations.RunPython(seed_kind_durations, unseed_kind_durations),
    ]
