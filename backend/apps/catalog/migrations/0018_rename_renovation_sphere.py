"""Сфера `renovation` → «Ремонт и строительство» (замечание отсмотра
2026-08-20): сид 0006 назвал её просто «Ремонт», и в RU-контуре (name_i18n,
не языковые пакеты — докстринг apps.l10n.selectors) это имя путалось с
«Ремонт техники» (appliance) и «Домашние работы и мелкий ремонт» (household).
Пакеты ru/en уже несут полное имя (`catalog.spheres.renovation`) — здесь
name_i18n приводится к ним. Только данные, схема не меняется."""

from django.db import migrations

_NEW = {"ru": "Ремонт и строительство", "en": "Renovation & construction"}
_OLD = {"ru": "Ремонт", "en": "Renovation"}


def _set_names(apps, names):
    Sphere = apps.get_model("catalog", "Sphere")
    row = Sphere.objects.filter(code="renovation").first()
    if row is None:
        return
    row.name_i18n = {**row.name_i18n, **names}
    row.save(update_fields=["name_i18n"])


def rename(apps, schema_editor):
    _set_names(apps, _NEW)


def unrename(apps, schema_editor):
    _set_names(apps, _OLD)


class Migration(migrations.Migration):
    dependencies = [
        ("catalog", "0017_clean_jurisdiction_marker_from_existing_items"),
    ]

    operations = [migrations.RunPython(rename, unrename)]
