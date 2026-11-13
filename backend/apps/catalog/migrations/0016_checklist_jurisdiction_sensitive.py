# Generated for ADR-081 (доп. 2026-08-12): «[Л]»/«[L]» → is_jurisdiction_sensitive

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("catalog", "0015_deactivate_or_delete_tutoring_sphere"),
    ]

    operations = [
        migrations.AddField(
            model_name="checklisttemplateitem",
            name="is_jurisdiction_sensitive",
            field=models.BooleanField(default=False),
        ),
    ]
