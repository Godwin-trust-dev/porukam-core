"""Хвост волны 4 (docs/backlog.md «Найдено агентами 25.08»): реплики
`POST /disputes/{id}/respond` жили только в payload outbox-события
`dispute.responded` — карточка спора текст ответа не показывала. Своя
таблица `dispute_reply`, потому что ответ стороны на разногласие —
юрзначимое заявление (ADR-019), а outbox — техническая таблица реле."""


import common.uuid7
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('disputes', '0002_etap7'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='DisputeReply',
            fields=[
                ('id', models.UUIDField(default=common.uuid7.uuid7, editable=False, primary_key=True, serialize=False)),
                ('comment', models.TextField(blank=True, default='')),
                ('evidence', models.JSONField(blank=True, default=list)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('author', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='+', to=settings.AUTH_USER_MODEL)),
                ('dispute', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='replies', to='disputes.dispute')),
            ],
            options={
                'verbose_name': 'реплика по разногласию',
                'verbose_name_plural': 'реплики по разногласию',
                'db_table': 'dispute_reply',
                'ordering': ['created_at'],
            },
        ),
    ]
