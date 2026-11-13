# Дедупликация сфер (chore/sphere-dedup, apps.catalog.migrations.
# 0014_dedupe_tutoring_into_education): `Milestone.sphere` — единственная
# FK-ссылка на `catalog.Sphere` за пределами apps.catalog
# (on_delete=PROTECT, apps/milestones/models.py) — пока на `tutoring`
# ссылается хоть один Milestone, apps.catalog не сможет её удалить
# (0015_deactivate_or_delete_tutoring_sphere зависит от этой миграции
# именно поэтому).
from django.db import migrations


def repoint_forward(apps, schema_editor):
    Sphere = apps.get_model("catalog", "Sphere")
    Milestone = apps.get_model("milestones", "Milestone")

    tutoring = Sphere.objects.filter(code="tutoring").first()
    if tutoring is None:
        return
    education = Sphere.objects.get(code="education")  # заведён 0014, до этой миграции
    Milestone.objects.filter(sphere=tutoring).update(sphere=education)


def repoint_backward(apps, schema_editor):
    # См. apps.catalog.migrations.0014 dedupe_backward — слияние двух строк
    # необратимо миграцией, откат только вручную по бэкапу.
    pass


class Migration(migrations.Migration):
    dependencies = [
        ("milestones", "0004_execution_gate_fields"),
        ("catalog", "0014_dedupe_tutoring_into_education"),
    ]

    operations = [
        migrations.RunPython(repoint_forward, repoint_backward),
    ]
