"""Сид ГВ.1 (docs/tasks/global-wave.md, ADR-070): активация USD/EUR в
справочнике валют — «Р1: активна только RUB» (0002_seed_rub) снимается для
GLOBAL-контура (apps.jurisdictions 0004_seed_ru_and_global использует эти
коды в allowed_currency_codes). Справочник остаётся универсальным (ADR-041,
одна таблица на все страны) — is_active здесь глобальный на валюту, а не
per-контур; per-контур список — allowed_currency_codes в JurisdictionConfig."""

from django.db import migrations

_CURRENCIES = [
    {
        "code": "USD",
        "numeric_code": "840",
        "name_i18n": {"ru": "Доллар США", "en": "US Dollar"},
        "symbol": "$",
        "decimal_places": 2,
        "is_active": True,
    },
    {
        "code": "EUR",
        "numeric_code": "978",
        "name_i18n": {"ru": "Евро", "en": "Euro"},
        "symbol": "€",
        "decimal_places": 2,
        "is_active": True,
    },
]


def seed_usd_eur(apps, schema_editor):
    Currency = apps.get_model("catalog", "Currency")
    for currency in _CURRENCIES:
        defaults = {key: value for key, value in currency.items() if key != "code"}
        Currency.objects.update_or_create(code=currency["code"], defaults=defaults)


def unseed_usd_eur(apps, schema_editor):
    Currency = apps.get_model("catalog", "Currency")
    Currency.objects.filter(code__in=["USD", "EUR"]).delete()


class Migration(migrations.Migration):
    dependencies = [("catalog", "0006_seed_spheres_materials_checklists")]

    operations = [
        migrations.RunPython(seed_usd_eur, unseed_usd_eur),
    ]
