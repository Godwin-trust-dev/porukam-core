"""Сид ГВ.3 (docs/tasks/global-wave.md): контур GLOBAL не хранит оригиналы
доказательств на сервере — только hash+миниатюра+метаданные
(apps.evidence.services, ADR-060 §8 приложение п. 10). RU не трогаем —
дефолт поля (True, миграция 0007) уже верен для строки RU."""

from django.db import migrations

from apps.jurisdictions.models import GLOBAL_COUNTRY_CODE


def seed_global_no_server_storage(apps, schema_editor):
    JurisdictionConfig = apps.get_model("jurisdictions", "JurisdictionConfig")
    JurisdictionConfig.objects.filter(country_code=GLOBAL_COUNTRY_CODE).update(
        evidence_server_storage_enabled=False
    )


def unseed_global_no_server_storage(apps, schema_editor):
    JurisdictionConfig = apps.get_model("jurisdictions", "JurisdictionConfig")
    JurisdictionConfig.objects.filter(country_code=GLOBAL_COUNTRY_CODE).update(
        evidence_server_storage_enabled=True
    )


class Migration(migrations.Migration):
    dependencies = [
        ("jurisdictions", "0007_jurisdictionconfig_evidence_server_storage_enabled"),
    ]

    operations = [
        migrations.RunPython(seed_global_no_server_storage, unseed_global_no_server_storage),
    ]
