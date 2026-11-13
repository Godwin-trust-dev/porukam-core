"""Сфера `it` — исправление `name_i18n` (решение владельца 12.09, дословно:
«IT и разработка мне нравится больше, если честно» — про название сферы `it`).

RU-контур показывает имя сферы напрямую из `Sphere.name_i18n['ru']` (пакет
`catalog.spheres.<code>` для этого контура не применяется, см. ADR-188,
раздел «Дополнение 12.09»); остальные 28 языков читают имя из пакета
(`l10n/packs/<locale>.json`, ключ `catalog.spheres.it` — правится отдельным
PR по пакетам того же PR/ветки). Значение `ru`/`en` здесь совпадает с тем,
что записано в пакете `en.json` (`IT & development`), чтобы оба источника
не расходились по смыслу.

До этой миграции: `name_i18n == {"en": "IT", "ru": "IT"}` — короткая форма,
без «и разработка» / «and development». Только данные, схема не меняется."""

from django.db import migrations

_NEW = {"ru": "IT и разработка", "en": "IT & development"}
_OLD = {"en": "IT", "ru": "IT"}


def fix(apps, schema_editor):
    Sphere = apps.get_model("catalog", "Sphere")
    row = Sphere.objects.filter(code="it").first()
    if row is None:
        return
    row.name_i18n = {**row.name_i18n, **_NEW}
    row.save(update_fields=["name_i18n"])


def unfix(apps, schema_editor):
    Sphere = apps.get_model("catalog", "Sphere")
    row = Sphere.objects.filter(code="it").first()
    if row is None:
        return
    row.name_i18n = dict(_OLD)
    row.save(update_fields=["name_i18n"])


class Migration(migrations.Migration):
    dependencies = [
        ("catalog", "0020_fix_sales_sphere_name"),
    ]

    operations = [migrations.RunPython(fix, unfix)]
