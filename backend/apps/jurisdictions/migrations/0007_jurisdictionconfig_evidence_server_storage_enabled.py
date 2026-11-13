"""ГВ.3 (docs/tasks/global-wave.md): флаг режима evidence per-контур — см.
докстринг `JurisdictionConfig.evidence_server_storage_enabled`. `default=True`
верен для RU без отдельной строки (существующая ветка не меняется); GLOBAL
выключается сидом 0008."""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('jurisdictions', '0006_seed_global_primary_locale_en'),
    ]

    operations = [
        migrations.AddField(
            model_name='jurisdictionconfig',
            name='evidence_server_storage_enabled',
            field=models.BooleanField(default=True),
        ),
    ]
