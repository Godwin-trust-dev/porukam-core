"""Сид справочника валют — RUB (tech-spec.md §5.2.5, ревизия 2.0.3)."""

from django.db import migrations


def seed_rub(apps, schema_editor):
    Currency = apps.get_model("catalog", "Currency")
    Currency.objects.update_or_create(
        code="RUB",
        defaults={
            "numeric_code": "643",
            "name_i18n": {"ru": "Российский рубль", "en": "Russian ruble"},
            "symbol": "₽",
            "decimal_places": 2,
            "is_active": True,
        },
    )


def unseed_rub(apps, schema_editor):
    Currency = apps.get_model("catalog", "Currency")
    Currency.objects.filter(code="RUB").delete()


class Migration(migrations.Migration):
    dependencies = [("catalog", "0001_initial")]

    operations = [
        migrations.RunPython(seed_rub, unseed_rub),
    ]
