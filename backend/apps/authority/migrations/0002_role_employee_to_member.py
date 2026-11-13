"""Роль представителя: employee -> member (ADR-203).

Терминологическая красная линия (отсутствие лексики трудовых отношений в коде и API):
значение «employee / Сотрудник» заменено на «member / Участник». Само значение в CHECK-констрейнтах
не зашито (0001 — только choices), поэтому достаточно AlterField + миграции данных.
"""

from django.db import migrations, models


def employee_to_member(apps, schema_editor):
    Representative = apps.get_model("authority", "Representative")
    Representative.objects.filter(role="employee").update(role="member")


def member_to_employee(apps, schema_editor):
    Representative = apps.get_model("authority", "Representative")
    Representative.objects.filter(role="member").update(role="employee")


class Migration(migrations.Migration):
    dependencies = [
        ("authority", "0001_initial"),
    ]

    operations = [
        migrations.AlterField(
            model_name="representative",
            name="role",
            field=models.CharField(
                choices=[
                    ("administrator", "Администратор"),
                    ("manager", "Менеджер"),
                    ("member", "Участник"),
                ],
                max_length=16,
            ),
        ),
        migrations.RunPython(employee_to_member, member_to_employee),
    ]
