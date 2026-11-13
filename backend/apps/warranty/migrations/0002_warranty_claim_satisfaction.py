"""ADR-133 (подтверждение гарантийной претензии заказчиком + автоподтверждение):
статус `awaiting_confirmation`, счётчик возражений `fix_rounds_used` (CHECK <= 2,
тот же потолок, что у раундов спора), `acceptance_deadline_id` (строка
`DomainDeadline` kind=warranty_claim_acceptance по значению), `fix_submitted_at`;
таблица `warranty_fix` — цикл «устранил -> подтвердил / не устранено»."""


import common.uuid7
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('contracts', '0008_contract_additional_terms'),
        ('warranty', '0001_etap7'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='WarrantyFix',
            fields=[
                ('id', models.UUIDField(default=common.uuid7.uuid7, editable=False, primary_key=True, serialize=False)),
                ('round', models.PositiveSmallIntegerField()),
                ('comment', models.TextField(blank=True, default='')),
                ('evidence', models.JSONField(blank=True, default=list)),
                ('submitted_at', models.DateTimeField(auto_now_add=True)),
                ('contest_comment', models.TextField(blank=True, default='')),
                ('contest_evidence', models.JSONField(blank=True, default=list)),
                ('contested_at', models.DateTimeField(blank=True, null=True)),
            ],
            options={
                'verbose_name': 'устранение по гарантийной претензии',
                'verbose_name_plural': 'устранения по гарантийной претензии',
                'db_table': 'warranty_fix',
                'ordering': ['claim_id', 'round'],
            },
        ),
        migrations.RemoveConstraint(
            model_name='warrantyclaim',
            name='warranty_claim_resolved_has_date',
        ),
        migrations.AddField(
            model_name='warrantyclaim',
            name='acceptance_deadline_id',
            field=models.UUIDField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='warrantyclaim',
            name='fix_rounds_used',
            field=models.PositiveSmallIntegerField(default=0),
        ),
        migrations.AddField(
            model_name='warrantyclaim',
            name='fix_submitted_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AlterField(
            model_name='warrantyclaim',
            name='status',
            field=models.CharField(choices=[('submitted', 'Подана'), ('awaiting_confirmation', 'Ждёт подтверждения заказчика'), ('resolved', 'Закрыта')], default='submitted', max_length=24),
        ),
        migrations.AddConstraint(
            model_name='warrantyclaim',
            constraint=models.CheckConstraint(condition=models.Q(models.Q(('resolved_at__isnull', False), ('status', 'resolved')), models.Q(('resolution_type', ''), ('resolved_at__isnull', True), ('status__in', ['submitted', 'awaiting_confirmation'])), _connector='OR'), name='warranty_claim_resolved_has_date'),
        ),
        migrations.AddConstraint(
            model_name='warrantyclaim',
            constraint=models.CheckConstraint(condition=models.Q(('fix_rounds_used__lte', 2)), name='warranty_claim_fix_rounds_within_cap'),
        ),
        migrations.AddConstraint(
            model_name='warrantyclaim',
            constraint=models.CheckConstraint(condition=models.Q(models.Q(('fix_submitted_at__isnull', False), ('status', 'awaiting_confirmation')), models.Q(('status', 'awaiting_confirmation'), _negated=True), _connector='OR'), name='warranty_claim_awaiting_has_fix_submitted_at'),
        ),
        migrations.AddField(
            model_name='warrantyfix',
            name='claim',
            field=models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='fixes', to='warranty.warrantyclaim'),
        ),
        migrations.AddField(
            model_name='warrantyfix',
            name='contested_by',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name='+', to=settings.AUTH_USER_MODEL),
        ),
        migrations.AddField(
            model_name='warrantyfix',
            name='submitted_by',
            field=models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='+', to=settings.AUTH_USER_MODEL),
        ),
        migrations.AddConstraint(
            model_name='warrantyfix',
            constraint=models.UniqueConstraint(fields=('claim', 'round'), name='warranty_fix_round_unique'),
        ),
        migrations.AddConstraint(
            model_name='warrantyfix',
            constraint=models.CheckConstraint(condition=models.Q(('round__gte', 1), ('round__lte', 3)), name='warranty_fix_round_within_cap'),
        ),
        migrations.AddConstraint(
            model_name='warrantyfix',
            constraint=models.CheckConstraint(condition=models.Q(models.Q(('contested_at__isnull', False), ('contested_by__isnull', False)), models.Q(('contested_at__isnull', True), ('contested_by__isnull', True)), _connector='OR'), name='warranty_fix_contest_has_author'),
        ),
    ]
