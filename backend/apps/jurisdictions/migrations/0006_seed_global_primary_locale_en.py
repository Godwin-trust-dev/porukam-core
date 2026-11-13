"""Сид ГВ.5 (docs/tasks/global-wave.md, ADR-075): язык контура GLOBAL — EN.

RU не трогаем — дефолт поля primary_locale ("ru", миграция 0005) уже верен
для строки RU, отдельно проставлять нечего."""

from django.db import migrations

from apps.jurisdictions.models import GLOBAL_COUNTRY_CODE


def seed_global_locale(apps, schema_editor):
    JurisdictionConfig = apps.get_model("jurisdictions", "JurisdictionConfig")
    JurisdictionConfig.objects.filter(country_code=GLOBAL_COUNTRY_CODE).update(
        primary_locale="en"
    )


def unseed_global_locale(apps, schema_editor):
    JurisdictionConfig = apps.get_model("jurisdictions", "JurisdictionConfig")
    JurisdictionConfig.objects.filter(country_code=GLOBAL_COUNTRY_CODE).update(
        primary_locale="ru"
    )


class Migration(migrations.Migration):
    dependencies = [("jurisdictions", "0005_jurisdictionconfig_primary_locale")]

    operations = [
        migrations.RunPython(seed_global_locale, unseed_global_locale),
    ]
