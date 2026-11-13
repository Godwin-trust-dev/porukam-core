"""Сфера `sales` — исправление `name_i18n` (дефект прод 12.09, докладная
владельца: «опять в названии вылезло сфера "Продажи (архетип сделки sale,
док 24)", нужно просто Продажи»).

Причина: `_import_sphere_file` (apps.catalog.services) пишет имя в
`Sphere.name_i18n` только при СОЗДАНИИ строки (`get_or_create(defaults=...)`)
— обычный переимпорт чек-листов при деплое существующее имя не трогает.
Имя было испорчено парсером шапки `CL-sales_GLOBAL.md`
(«Сфера 17: `sales` — Продажи (архетип сделки sale, док 24).») до
исправления парсера (`checklist_markdown._strip_author_note`, тот же PR) —
парсер брал всё до точки в конце строки, включая авторскую скобку.
Такой же случай уже чинили миграцией 0018 (сфера `renovation`) — здесь то
же самое, только для `sales`.

Проверены все 18 сфер на момент миграции — со скобкой в name_i18n была
только `sales` (`renovation` уже приведена 0018-й, `other` изначально
чистая). Только данные, схема не меняется."""

from django.db import migrations

_NEW = {"ru": "Продажи", "en": "Sales"}
_OLD = {"ru": "Продажи (архетип сделки sale, док 24)"}


def fix(apps, schema_editor):
    Sphere = apps.get_model("catalog", "Sphere")
    row = Sphere.objects.filter(code="sales").first()
    if row is None:
        return
    row.name_i18n = {**row.name_i18n, **_NEW}
    row.save(update_fields=["name_i18n"])


def unfix(apps, schema_editor):
    # До этой миграции у `sales` был только ключ `ru` (без `en`) — восстанавливаем
    # исходный словарь целиком, а не сливаем (иначе `en`, добавленный вперёд, останется).
    Sphere = apps.get_model("catalog", "Sphere")
    row = Sphere.objects.filter(code="sales").first()
    if row is None:
        return
    row.name_i18n = dict(_OLD)
    row.save(update_fields=["name_i18n"])


class Migration(migrations.Migration):
    dependencies = [
        ("catalog", "0019_checklisttemplatepickstat"),
    ]

    operations = [migrations.RunPython(fix, unfix)]
