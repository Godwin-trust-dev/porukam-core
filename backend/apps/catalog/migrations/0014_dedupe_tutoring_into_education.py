# Дедупликация сфер (chore/sphere-dedup): `tutoring` (заглушка Э4.1,
# миграция 0006 — временный список из 7 кодов, apps/contracts/forms.py
# докстринг «до появления реальных таблиц») и `education` (контентный
# трек П-03, docs/content/checklists/CL-education_GLOBAL.md,
# import_checklists, ADR-081) — один и тот же домен («Обучение и
# репетиторство»/«Education & tutoring», см. l10n/packs/*.json
# catalog.spheres.education) под двумя кодами.
#
# Эта миграция — первый шаг: заводит `education` (если ещё не создан
# import_checklists — деплой-пайплайн запускает его ПОСЛЕ migrate,
# ADR-081, так что на чистой БД `education` здесь появляется впервые) и
# перепривязывает СОБСТВЕННЫЕ ссылки apps.catalog (MaterialCatalogItem,
# ChecklistTemplateItem) с `tutoring` на `education`. Сам `tutoring` НЕ
# трогается здесь — деактивация/удаление отложена до 0015, которая
# дожидается apps.milestones (Milestone.sphere, on_delete=PROTECT) —
# удалить Sphere, пока на неё ссылается защищённый FK из другого
# приложения, нельзя.
from django.db import migrations


def dedupe_forward(apps, schema_editor):
    Sphere = apps.get_model("catalog", "Sphere")
    MaterialCatalogItem = apps.get_model("catalog", "MaterialCatalogItem")
    ChecklistTemplateItem = apps.get_model("catalog", "ChecklistTemplateItem")

    education, _created = Sphere.objects.get_or_create(
        code="education",
        defaults={
            "name_i18n": {"ru": "Обучение и репетиторство", "en": "Education & tutoring"},
            "is_active": True,
        },
    )

    tutoring = Sphere.objects.filter(code="tutoring").first()
    if tutoring is None:
        return  # уже продедуплено (или сид 0006 в этой БД не применялся)

    for material in MaterialCatalogItem.objects.filter(sphere=tutoring):
        if material.code == "other_tutoring":
            # "other_education" ещё не существует: import_checklists не
            # заводит материалы для education (CL-education_GLOBAL.md §2
            # «Не ведётся») — единственный владелец этого кода после
            # переименования.
            material.code = "other_education"
        material.sphere = education
        material.save(update_fields=["code", "sphere"])

    ChecklistTemplateItem.objects.filter(sphere=tutoring).update(sphere=education)


def dedupe_backward(apps, schema_editor):
    # Необратимо осознанно: 0015 может успеть удалить строку `tutoring`
    # целиком, восстановить прежний code/sphere тогда нечем. Откат этой
    # ветки дедупликации — вручную по бэкапу, не миграцией (тот же приём,
    # что необратимые data-миграции в этом репозитории, например 0006
    # умеет откатываться, но она заводит данные, а не сливает две строки).
    pass


class Migration(migrations.Migration):
    dependencies = [
        ("catalog", "0013_checklist_versioning"),
    ]

    operations = [
        migrations.RunPython(dedupe_forward, dedupe_backward),
    ]
