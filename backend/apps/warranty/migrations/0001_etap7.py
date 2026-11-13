"""Этап 7 (docs/plan.md «Споры и гарантия», ADR-131): `warranty_claim` из
tech-spec.md §5.2.7 — первая таблица приложения `apps.warranty`, до этого
существовавшего только README-заглушкой (этап 1)."""

import common.uuid7
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('contracts', '0008_contract_additional_terms'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='WarrantyClaim',
            fields=[
                ('id', models.UUIDField(default=common.uuid7.uuid7, editable=False, primary_key=True, serialize=False)),
                ('description', models.TextField()),
                ('evidence', models.JSONField(blank=True, default=list)),
                ('status', models.CharField(choices=[('submitted', 'Подана'), ('resolved', 'Закрыта')], default='submitted', max_length=16)),
                ('resolution_type', models.CharField(blank=True, default='', max_length=32)),
                ('dispute_id', models.UUIDField(blank=True, null=True)),
                ('submitted_at', models.DateTimeField(auto_now_add=True)),
                ('resolved_at', models.DateTimeField(blank=True, null=True)),
                ('contract', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='warranty_claims', to='contracts.contract')),
                ('submitted_by', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'verbose_name': 'гарантийная заявка',
                'verbose_name_plural': 'гарантийные заявки',
                'db_table': 'warranty_claim',
                'ordering': ['-submitted_at'],
                'constraints': [models.CheckConstraint(condition=models.Q(models.Q(('resolved_at__isnull', False), ('status', 'resolved')), models.Q(('resolution_type', ''), ('resolved_at__isnull', True), ('status', 'submitted')), _connector='OR'), name='warranty_claim_resolved_has_date')],
            },
        ),
    ]
