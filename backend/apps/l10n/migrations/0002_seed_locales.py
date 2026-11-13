"""Сид Л.2 (docs/tasks/l10n-wave.md п.1): en (canonical — язык канона
блоков договора, доку 32) и ru (reviewed — родной язык RU-контура,
переводится людьми, не машиной). Данные миграции, не код (тот же приём,
что apps.jurisdictions 0004_seed_ru_and_global) — остальные языки заводит
`import_l10n_pack` из шапки пакета (services.import_pack), не миграции."""

from django.db import migrations


def seed_locales(apps, schema_editor):
    Locale = apps.get_model("l10n", "Locale")

    Locale.objects.update_or_create(
        code="en",
        defaults={"name": "English", "rtl": False, "enabled": True, "quality": "canonical"},
    )
    Locale.objects.update_or_create(
        code="ru",
        defaults={"name": "Русский", "rtl": False, "enabled": True, "quality": "reviewed"},
    )


def unseed_locales(apps, schema_editor):
    Locale = apps.get_model("l10n", "Locale")
    Locale.objects.filter(code__in=["en", "ru"]).delete()


class Migration(migrations.Migration):
    dependencies = [("l10n", "0001_initial")]

    operations = [
        migrations.RunPython(seed_locales, unseed_locales),
    ]
