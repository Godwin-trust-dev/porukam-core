"""Сид ГВ.5 (docs/tasks/global-wave.md, ADR-075): description_i18n для
четырёх пунктов чек-листа, засеянных 0006 (минимальный набор для тестов
Э4.3) — RU-копия текущего description + EN-болванка. Ключ — сам текст
description (естественный ключ этой модели, см. 0006), не id (генерируется
uuid7 на лету, в сид-миграциях не фиксирован)."""

from django.db import migrations

_DESCRIPTIONS_I18N = {
    "Плитка уложена без перепадов по высоте": "Tile is laid without height differences",
    "Швы между плитками ровные и затёрты": "Grout lines between tiles are even and filled",
    "Стыки полотен не расходятся и рисунок совмещён": (
        "Wallpaper seams do not separate and the pattern is aligned"
    ),
    "После завершения работ помещение убрано от строительного мусора": (
        "The premises are cleared of construction debris after work is completed"
    ),
}


def seed(apps, schema_editor):
    ChecklistTemplateItem = apps.get_model("catalog", "ChecklistTemplateItem")
    for description_ru, description_en in _DESCRIPTIONS_I18N.items():
        for item in ChecklistTemplateItem.objects.filter(description=description_ru):
            item.description_i18n = {"ru": description_ru, "en": description_en}
            item.save(update_fields=["description_i18n"])


def unseed(apps, schema_editor):
    ChecklistTemplateItem = apps.get_model("catalog", "ChecklistTemplateItem")
    for description_ru in _DESCRIPTIONS_I18N:
        ChecklistTemplateItem.objects.filter(description=description_ru).update(
            description_i18n={}
        )


class Migration(migrations.Migration):
    dependencies = [("catalog", "0009_checklist_description_i18n")]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
