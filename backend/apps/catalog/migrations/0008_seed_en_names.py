"""Сид ГВ.5 (docs/tasks/global-wave.md, ADR-075): EN-ключ в name_i18n —
механизм («выбор языка по контуру»), не полное содержание — финальные
тексты придут отдельным контентным пакетом (тот же принцип, что RU-тексты
изначально были только сидом Р1/минимального набора).

ContractTypeCatalogItem — только 7 кодов клиентского дерева Р1
(docs/catalog-v2.md §2); остальные (excluded/special/Р2 hidden) не
показываются пользователю ни в одном контуре — EN здесь не нужен.
Sphere — все текущие 7 кодов (полные 17 — отдельный контентный трек П-03/Б9,
apps/catalog/migrations/0006, вне этой миграции)."""

from django.db import migrations

_CONTRACT_TYPE_NAMES_EN = {
    "services_individual": "Service — contractor without business status",
    "services_business": "Service — self-employed/sole proprietor/legal entity contractor",
    "sale_personal": "Sale — individual seller (personal property)",
    "sale_business": "Sale — business seller",
    "rent_items": "Rental — items",
    "rent_home": "Rental — housing",
    "loan_individuals": "Loan between individuals",
}

_SPHERE_NAMES_EN = {
    "renovation": "Renovation",
    "delivery": "Delivery",
    "tutoring": "Tutoring",
    "it": "IT",
    "household": "Household services",
    "design": "Design",
    "other": "Other",
}


def _add_en_key(model, names_en):
    for code, name_en in names_en.items():
        row = model.objects.filter(code=code).first()
        if row is None:
            continue
        row.name_i18n = {**row.name_i18n, "en": name_en}
        row.save(update_fields=["name_i18n"])


def _remove_en_key(model, names_en):
    for code in names_en:
        row = model.objects.filter(code=code).first()
        if row is None:
            continue
        row.name_i18n = {k: v for k, v in row.name_i18n.items() if k != "en"}
        row.save(update_fields=["name_i18n"])


def seed_en_names(apps, schema_editor):
    ContractTypeCatalogItem = apps.get_model("catalog", "ContractTypeCatalogItem")
    Sphere = apps.get_model("catalog", "Sphere")
    _add_en_key(ContractTypeCatalogItem, _CONTRACT_TYPE_NAMES_EN)
    _add_en_key(Sphere, _SPHERE_NAMES_EN)


def unseed_en_names(apps, schema_editor):
    ContractTypeCatalogItem = apps.get_model("catalog", "ContractTypeCatalogItem")
    Sphere = apps.get_model("catalog", "Sphere")
    _remove_en_key(ContractTypeCatalogItem, _CONTRACT_TYPE_NAMES_EN)
    _remove_en_key(Sphere, _SPHERE_NAMES_EN)


class Migration(migrations.Migration):
    dependencies = [("catalog", "0007_seed_usd_eur")]

    operations = [
        migrations.RunPython(seed_en_names, unseed_en_names),
    ]
