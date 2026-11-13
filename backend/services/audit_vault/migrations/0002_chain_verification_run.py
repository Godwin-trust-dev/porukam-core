from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("audit_vault", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="ChainVerificationRun",
            fields=[
                ("id", models.BigAutoField(primary_key=True, serialize=False)),
                ("ok", models.BooleanField()),
                ("entries_checked", models.PositiveIntegerField()),
                ("first_broken_seq", models.BigIntegerField(blank=True, null=True)),
                ("verified_at", models.DateTimeField(auto_now_add=True)),
            ],
            options={
                "verbose_name": "прогон проверки цепочки Vault",
                "verbose_name_plural": "прогоны проверки цепочки Vault",
                "db_table": "audit_chain_verification_run",
                "ordering": ["-verified_at"],
            },
        ),
    ]
