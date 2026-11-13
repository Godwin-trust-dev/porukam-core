"""Дополнение 26.08 к ADR-133: признак автозакрытия претензии для API —
`resolved_by` (кто закрыл; NULL у системного исхода) и `resolved_auto`
(истекло окно подтверждения / потолок спора). CHECK: автозакрытие — только у
закрытой претензии и без актора. Существующие закрытые претензии остаются
`resolved_auto=false, resolved_by=NULL` — восстановить актора задним числом
по outbox нельзя (таблица реле чистится), а угадывать юрфакт не стоит."""


import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('contracts', '0008_contract_additional_terms'),
        ('warranty', '0002_warranty_claim_satisfaction'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name='warrantyclaim',
            name='resolved_auto',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='warrantyclaim',
            name='resolved_by',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name='+', to=settings.AUTH_USER_MODEL),
        ),
        migrations.AddConstraint(
            model_name='warrantyclaim',
            constraint=models.CheckConstraint(condition=models.Q(('resolved_auto', False), models.Q(('resolved_by__isnull', True), ('status', 'resolved')), _connector='OR'), name='warranty_claim_auto_resolution_has_no_actor'),
        ),
    ]
