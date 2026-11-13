"""ГВ.3 (docs/tasks/global-wave.md): Evidence — hash+миниатюра+метаданные у
платформы, оригиналы у сторон (GLOBAL) / S3 (RU, за флагом JurisdictionConfig.
evidence_server_storage_enabled). См. apps/evidence/models.py."""

import common.uuid7
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('contracts', '0005_alter_contract_execution_status'),
        ('disputes', '0001_initial'),
        ('milestones', '0004_execution_gate_fields'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='Evidence',
            fields=[
                ('id', models.UUIDField(default=common.uuid7.uuid7, editable=False, primary_key=True, serialize=False)),
                ('file_name', models.CharField(max_length=255)),
                ('mime_type', models.CharField(max_length=100)),
                ('file_size', models.PositiveIntegerField()),
                ('file_hash', models.CharField(max_length=64)),
                ('trusted_timestamp_at', models.DateTimeField()),
                ('trusted_timestamp_source', models.CharField(max_length=32)),
                ('thumbnail', models.BinaryField(blank=True, null=True)),
                ('metadata', models.JSONField(blank=True, default=dict)),
                ('storage_mode', models.CharField(choices=[('global', 'GLOBAL (без хранения оригинала)'), ('ru', 'RU (серверное хранение)')], max_length=8)),
                ('transit_payload', models.BinaryField(blank=True, null=True)),
                ('s3_object_key', models.CharField(blank=True, default='', max_length=255)),
                ('uploader_retained_at', models.DateTimeField(auto_now_add=True)),
                ('delivered_to_counterparty_at', models.DateTimeField(blank=True, null=True)),
                ('delivery_status', models.CharField(choices=[('in_transit', 'В транзите'), ('delivered', 'Доставлено')], default='in_transit', max_length=16)),
                ('backup_status', models.CharField(choices=[('not_requested', 'Не запрошен'), ('pending', 'В процессе'), ('completed', 'Завершён'), ('failed', 'Ошибка')], default='not_requested', max_length=16)),
                ('backup_provider', models.CharField(blank=True, default='', max_length=32)),
                ('backup_completed_at', models.DateTimeField(blank=True, null=True)),
                ('backup_failure_reason', models.TextField(blank=True, default='')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('checklist_item', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='evidence_items', to='milestones.checklistitem')),
                ('contract', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='evidence_items', to='contracts.contract')),
                ('dispute', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='evidence_items', to='disputes.dispute')),
                ('milestone', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='evidence_items', to='milestones.milestone')),
                ('uploaded_by', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='uploaded_evidence', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'verbose_name': 'доказательство',
                'verbose_name_plural': 'доказательства',
                'db_table': 'evidence',
                'ordering': ['-created_at'],
                'indexes': [models.Index(fields=['contract', 'milestone'], name='evidence_contrac_0b2242_idx')],
                'constraints': [models.CheckConstraint(condition=models.Q(('milestone__isnull', False), ('dispute__isnull', False), _connector='OR'), name='evidence_attached_to_milestone_or_dispute')],
            },
        ),
    ]
