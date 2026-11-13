"""Э4.6 (docs/tasks/etap-4.md): поля гейта листа и денежных заглушек-
подтверждений — см. докстринги полей в apps/milestones/models.py."""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('milestones', '0003_milestone_created_by_amendment'),
    ]

    operations = [
        migrations.AddField(
            model_name='milestone',
            name='advance_confirmed_by_contractor_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='milestone',
            name='advance_confirmed_by_customer_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='milestone',
            name='paid_confirmed_by_contractor_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='milestone',
            name='paid_confirmed_by_customer_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='milestone',
            name='started_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
