"""Э4.6 (docs/tasks/etap-4.md): минимальная модель Dispute-заглушка — см.
apps/disputes/models.py."""

import common.uuid7
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('milestones', '0004_execution_gate_fields'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='Dispute',
            fields=[
                ('id', models.UUIDField(default=common.uuid7.uuid7, editable=False, primary_key=True, serialize=False)),
                ('evidence', models.JSONField(blank=True, default=list)),
                ('status', models.CharField(choices=[('open', 'Открыт'), ('resolved', 'Закрыт')], default='open', max_length=16)),
                ('resolution_type', models.CharField(blank=True, default='', max_length=32)),
                ('opened_at', models.DateTimeField(auto_now_add=True)),
                ('resolved_at', models.DateTimeField(blank=True, null=True)),
                ('checklist_item', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='disputes', to='milestones.checklistitem')),
                ('milestone', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='disputes', to='milestones.milestone')),
                ('opened_by', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'verbose_name': 'спор',
                'verbose_name_plural': 'споры',
                'db_table': 'dispute',
                'ordering': ['-opened_at'],
            },
        ),
    ]
