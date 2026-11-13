"""Сфера `delivery` — исправление `name_i18n` (решение владельца 12.09, дословно:
«везде более полный вариант, потому что автоуслуги могут включать перевозки,
а это логистика. Более полные названия делают навигацию проще и понятнее»).

Три разных названия сферы существовали одновременно: БД «Доставка», пакет
`catalog.spheres.delivery` — «Доставка и логистика», шапка
`docs/content/checklists/CL-delivery_GLOBAL.md` — «Перевозки и доставка».
Владелец прямо выбрала «Перевозки и доставка»: перевозки должны читаться
именно в сфере `delivery`, чтобы не путаться со сферой `auto` (та сузилась
до «Транспорт: ремонт и обслуживание» — ремонт и обслуживание транспорта,
без слова «перевозки», отдельным PR по пакетам той же ветки).

RU-контур показывает имя сферы напрямую из `Sphere.name_i18n['ru']` (пакет
для этого контура не применяется, см. ADR-188, раздел «Дополнение 12.09»);
остальные 28 языков читают имя из пакета — `catalog.spheres.delivery`
правится тем же PR. Значение `en` здесь совпадает с пакетом `en.json`
(`Transport & delivery`).

До этой миграции: `name_i18n == {"en": "Delivery", "ru": "Доставка"}`.
Только данные, схема не меняется."""

from django.db import migrations

_NEW = {"ru": "Перевозки и доставка", "en": "Transport & delivery"}
_OLD = {"en": "Delivery", "ru": "Доставка"}


def fix(apps, schema_editor):
    Sphere = apps.get_model("catalog", "Sphere")
    row = Sphere.objects.filter(code="delivery").first()
    if row is None:
        return
    row.name_i18n = {**row.name_i18n, **_NEW}
    row.save(update_fields=["name_i18n"])


def unfix(apps, schema_editor):
    Sphere = apps.get_model("catalog", "Sphere")
    row = Sphere.objects.filter(code="delivery").first()
    if row is None:
        return
    row.name_i18n = dict(_OLD)
    row.save(update_fields=["name_i18n"])


class Migration(migrations.Migration):
    dependencies = [
        ("catalog", "0021_fix_it_sphere_name"),
    ]

    operations = [migrations.RunPython(fix, unfix)]
