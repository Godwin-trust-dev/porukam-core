"""Л.1 (docs/tasks/l10n-wave.md, док 32 + уточнение v1.2, ADR-078): язык
канона + рендеры снепшота, locale показанного текста на SignatureRequest,
опциональный явный выбор языка на черновике. Только новые поля с дефолтами
(`canonical_language="en"`, `renders={}`, `locale=""`, `language_override=""`)
— НЕ трогает `ContractVersion.snapshot`/`integrity_hash`, пересчёта хешей уже
подписанных договоров нет (см. apps/contracts/tests/test_l10n_signing.py)."""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('contracts', '0005_alter_contract_execution_status'),
    ]

    operations = [
        migrations.AddField(
            model_name='contractversion',
            name='canonical_language',
            field=models.CharField(default='en', max_length=8),
        ),
        migrations.AddField(
            model_name='contractversion',
            name='renders',
            field=models.JSONField(blank=True, default=dict),
        ),
        migrations.AddField(
            model_name='signaturerequest',
            name='locale',
            field=models.CharField(blank=True, default='', max_length=8),
        ),
        migrations.AddField(
            model_name='contract',
            name='language_override',
            field=models.CharField(blank=True, default='', max_length=8),
        ),
    ]
