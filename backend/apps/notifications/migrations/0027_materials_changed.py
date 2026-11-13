"""ADR-156: уведомление о правках материалов этапа в согласовании.

Две вещи одной миграцией, потому что порознь они бессмысленны:

1. `PendingMaterialsChange` — строки окна схлопывания (пачка правок одного
   актора по одному этапу -> ОДНА карточка второй стороне). Строки в БД +
   минутный свип, а не отложенная Celery-задача (CLAUDE.md).
2. Строка `NotificationTemplate` для кода `contract.materials_changed`. Без
   неё `apps.notifications.services.place_notification` разместил бы
   уведомление с кодом, которого нет в таблице шаблонов, а `_place`
   подписчика — молча отбросил бы (тот же приём, что 0026). `body_i18n`
   ПУСТОЙ: источник текста для кодов-топиков — языковой пакет (`apps.l10n`,
   namespace `notifications.<code>`), см. `selectors.render_body`.

`legal_significance=False`: правка материалов до подписания не якорит
никакого срока (юрканал — размещение в ЛК, но тайм-аутов от этой карточки не
считается). Юрзначимость появляется только после подписания, а там правка
материалов уже невозможна (`_assert_editable`).
"""

from __future__ import annotations

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models

CODE = "contract.materials_changed"


def seed(apps, schema_editor):
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    NotificationTemplate.objects.update_or_create(
        code=CODE, defaults={"legal_significance": False, "body_i18n": {}}
    )


def unseed(apps, schema_editor):
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    NotificationTemplate.objects.filter(code=CODE).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("notifications", "0026_seed_material_handed_over_template"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="PendingMaterialsChange",
            fields=[
                ("id", models.BigAutoField(primary_key=True, serialize=False)),
                ("contract_id", models.UUIDField()),
                ("milestone_id", models.UUIDField()),
                ("milestone_title", models.CharField(blank=True, default="", max_length=300)),
                ("actor_id", models.UUIDField()),
                (
                    "change",
                    models.CharField(
                        choices=[
                            ("added", "Добавлен"),
                            ("updated", "Изменён"),
                            ("removed", "Удалён"),
                        ],
                        max_length=16,
                    ),
                ),
                ("source_event_id", models.UUIDField()),
                ("notify_at", models.DateTimeField()),
                ("notified_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "notification",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="materials_changes",
                        to="notifications.notification",
                    ),
                ),
                (
                    "recipient",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="pending_materials_changes",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "verbose_name": "правка материалов в ожидании уведомления",
                "verbose_name_plural": "правки материалов в ожидании уведомления",
                "db_table": "pending_materials_change",
            },
        ),
        migrations.AddConstraint(
            model_name="pendingmaterialschange",
            constraint=models.UniqueConstraint(
                fields=("recipient", "source_event_id"),
                name="unique_materials_change_per_source_event",
            ),
        ),
        migrations.AddIndex(
            model_name="pendingmaterialschange",
            index=models.Index(
                condition=models.Q(("notified_at__isnull", True)),
                fields=["notify_at"],
                name="materials_change_due_idx",
            ),
        ),
        migrations.RunPython(seed, unseed),
    ]
