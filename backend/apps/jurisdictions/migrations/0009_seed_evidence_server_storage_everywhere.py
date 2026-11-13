"""Решение владельца 26.08 (ADR-136 «Отмена части ГВ.3», ADR-137): оригиналы
доказательств хранятся на сервере во ВСЕХ юрисдикциях. GLOBAL-исключение
ГВ.3 (миграция 0008: `evidence_server_storage_enabled=False`) отменено —
на проде выяснилось, что GLOBAL-контур оригиналы не хранит вовсе
(`transit_payload` удалялся после доставки), а ADR-137 требует хранение
3 мес + до года и выдачу архива обеим сторонам. GDPR-аргумент ГВ.3
закрывается шифрованием at rest + сроками хранения + crypto-shredding.

Поле остаётся (обратимость: выключить серверное хранение для контура —
одна строка данных, код GLOBAL-пути жив). Откат миграции возвращает
GLOBAL в состояние 0008."""

from django.db import migrations

from apps.jurisdictions.models import GLOBAL_COUNTRY_CODE


def seed_server_storage_everywhere(apps, schema_editor):
    JurisdictionConfig = apps.get_model("jurisdictions", "JurisdictionConfig")
    JurisdictionConfig.objects.update(evidence_server_storage_enabled=True)


def unseed_server_storage_everywhere(apps, schema_editor):
    JurisdictionConfig = apps.get_model("jurisdictions", "JurisdictionConfig")
    JurisdictionConfig.objects.filter(country_code=GLOBAL_COUNTRY_CODE).update(
        evidence_server_storage_enabled=False
    )


class Migration(migrations.Migration):
    dependencies = [("jurisdictions", "0008_seed_global_evidence_no_server_storage")]

    operations = [
        migrations.RunPython(seed_server_storage_everywhere, unseed_server_storage_everywhere),
    ]
