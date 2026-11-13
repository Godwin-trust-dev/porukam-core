"""Э4.6 (docs/tasks/etap-4.md): Document — файл-заглушка как доказательство
формальной сдачи (существующая загрузка документов); см. apps/documents/models.py."""

import common.uuid7
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('contracts', '0005_alter_contract_execution_status'),
        ('milestones', '0004_execution_gate_fields'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='Document',
            fields=[
                ('id', models.UUIDField(default=common.uuid7.uuid7, editable=False, primary_key=True, serialize=False)),
                ('kind', models.CharField(choices=[('evidence', 'Доказательство сдачи этапа'), ('other', 'Прочее')], default='evidence', max_length=16)),
                ('file_name', models.CharField(max_length=255)),
                ('file_hash', models.CharField(blank=True, default='', max_length=64)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('checklist_item', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='documents', to='milestones.checklistitem')),
                ('contract', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='documents', to='contracts.contract')),
                ('milestone', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='documents', to='milestones.milestone')),
                ('uploaded_by', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='uploaded_documents', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'verbose_name': 'документ',
                'verbose_name_plural': 'документы',
                'db_table': 'document',
                'ordering': ['-created_at'],
            },
        ),
    ]
