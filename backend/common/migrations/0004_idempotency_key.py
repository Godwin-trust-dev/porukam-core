import common.uuid7
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("common", "0003_task_heartbeat"),
    ]

    operations = [
        migrations.CreateModel(
            name="IdempotencyKey",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=common.uuid7.uuid7,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("endpoint", models.CharField(max_length=100)),
                ("key", models.CharField(max_length=200)),
                ("request_hash", models.CharField(max_length=64)),
                ("response_status", models.PositiveSmallIntegerField()),
                ("response_body", models.JSONField()),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="idempotency_keys",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "verbose_name": "ключ идемпотентности",
                "verbose_name_plural": "ключи идемпотентности",
                "db_table": "idempotency_key",
            },
        ),
        migrations.AddConstraint(
            model_name="idempotencykey",
            constraint=models.UniqueConstraint(
                fields=("user", "endpoint", "key"),
                name="unique_idempotency_key_per_user_endpoint",
            ),
        ),
    ]
