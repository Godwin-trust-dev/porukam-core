from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("common", "0002_outbox_event_relay"),
    ]

    operations = [
        migrations.CreateModel(
            name="TaskHeartbeat",
            fields=[
                ("name", models.CharField(max_length=100, primary_key=True, serialize=False)),
                ("last_run_at", models.DateTimeField()),
            ],
            options={
                "verbose_name": "отметка периодической задачи",
                "verbose_name_plural": "отметки периодических задач",
                "db_table": "task_heartbeat",
            },
        ),
    ]
