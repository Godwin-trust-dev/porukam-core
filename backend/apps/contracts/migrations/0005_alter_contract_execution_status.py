"""Э4.6 (docs/tasks/etap-4.md): `Contract.execution_status` получает закрытый
список значений (`ExecutionStatus`, apps/contracts/models.py) — метаданные
поля, схема БД не меняется (CharField как был)."""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('contracts', '0004_amendment'),
    ]

    operations = [
        migrations.AlterField(
            model_name='contract',
            name='execution_status',
            field=models.CharField(blank=True, choices=[('pending_start', 'Ожидает старта'), ('in_progress', 'В работе'), ('terminated_by_customer', 'Расторгнут заказчиком'), ('terminated_by_contractor', 'Расторгнут исполнителем'), ('completed', 'Завершён'), ('warranty', 'Гарантия'), ('closed', 'Закрыт')], max_length=32, null=True),
        ),
    ]
