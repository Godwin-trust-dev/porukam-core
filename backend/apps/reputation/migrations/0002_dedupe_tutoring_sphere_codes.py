# Дедупликация сфер (chore/sphere-dedup): DealFact.sphere_codes — JSON-
# список кодов без FK (docstring DealFact) — subscriber.py пишет туда
# `milestone_sphere_code` из события milestones (см.
# apps.catalog.migrations.0014_dedupe_tutoring_into_education). Переписываем
# уже накопленные массивы: "tutoring" → "education", с дедупликацией (если
# в одном списке уже есть оба — не должно, но на всякий случай).
from django.db import migrations


def repoint_forward(apps, schema_editor):
    DealFact = apps.get_model("reputation", "DealFact")
    for fact in DealFact.objects.filter(sphere_codes__contains=["tutoring"]):
        updated = [code if code != "tutoring" else "education" for code in fact.sphere_codes]
        # Дедуп с сохранением порядка первого появления.
        deduped = list(dict.fromkeys(updated))
        fact.sphere_codes = deduped
        fact.save(update_fields=["sphere_codes"])


def repoint_backward(apps, schema_editor):
    # См. apps.catalog.migrations.0014 dedupe_backward — необратимо
    # миграцией (дедуп при forward уже мог схлопнуть два элемента в один).
    pass


class Migration(migrations.Migration):
    dependencies = [
        ("reputation", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(repoint_forward, repoint_backward),
    ]
