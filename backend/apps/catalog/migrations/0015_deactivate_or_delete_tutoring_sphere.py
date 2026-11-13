# Дедупликация сфер (chore/sphere-dedup) — финальный шаг: к этой точке
# 0014 перепривязала собственные ссылки apps.catalog, а
# milestones.0005_repoint_tutoring_milestones_to_education — единственную
# внешнюю FK (Milestone.sphere, PROTECT). Если что-то всё же ещё
# ссылается на `tutoring` (окружение, где милстоуны не мигрированы в этом
# же прогоне, или неучтённая ссылка) — delete() падает ProtectedError,
# фолбэк на is_active=False (задача явно требует именно такое поведение:
# «если FK не позволяют удалить — is_active=False и исключение из всех
# выдач»). is_active=False уже исключает строку из активных выдач каталога
# (селекторы/сиды фильтруют по is_active — тот же принцип, что у Currency/
# ContractTypeCatalogItem/MaterialCatalogItem).
from django.db import migrations
from django.db.models import ProtectedError


def finalize_forward(apps, schema_editor):
    Sphere = apps.get_model("catalog", "Sphere")
    tutoring = Sphere.objects.filter(code="tutoring").first()
    if tutoring is None:
        return
    try:
        tutoring.delete()
    except ProtectedError:
        tutoring.is_active = False
        tutoring.save(update_fields=["is_active"])


def finalize_backward(apps, schema_editor):
    # См. 0014 dedupe_backward — необратимо миграцией.
    pass


class Migration(migrations.Migration):
    dependencies = [
        ("catalog", "0014_dedupe_tutoring_into_education"),
        ("milestones", "0005_repoint_tutoring_milestones_to_education"),
    ]

    operations = [
        migrations.RunPython(finalize_forward, finalize_backward),
    ]
