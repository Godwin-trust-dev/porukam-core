"""ADR-155: двустороннее подтверждение материалов — «передано» (сторона-
источник) и «получено» (другая сторона).

Порядок между ними НЕ обязателен (уточнение владельца 03.09: «Исполнитель
может в одностороннем порядке поставить "получены". Сделаем жизнь людям чуть
легче»), поэтому CHECK «получено ⇒ передано» здесь не заводится: «передано» —
необязательный сигнал источника, а не предусловие получения.

Бэкфилл: до этой миграции существовал ОДИН флаг `received`, который ставила
любая сторона. У таких строк «передано» проставляется ровно там, где есть
чем: `handed_over_at = received_at` у `received=True`. Выдумывать метку из
`created_at` там, где `received_at` пуст, не стали — это была бы неверная
дата факта, а гейт этапа (`_materials_ready`) её всё равно не читает: он
смотрит на `received`.
"""

from __future__ import annotations

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models
from django.db.models import F


def backfill_handed_over(apps, schema_editor):
    ContractMaterial = apps.get_model("milestones", "ContractMaterial")
    ContractMaterial.objects.filter(
        received=True, received_at__isnull=False, handed_over_at__isnull=True
    ).update(handed_over_at=F("received_at"))


def noop_reverse(apps, schema_editor):
    """Обратная операция не нужна: колонки удаляются следующей операцией
    отката, данные уходят вместе с ними."""


class Migration(migrations.Migration):
    dependencies = [
        ("milestones", "0008_backfill_checklist_pick_stats"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="contractmaterial",
            name="handed_over_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="contractmaterial",
            name="handed_over_by",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="+",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddField(
            model_name="contractmaterial",
            name="received_by",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="+",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.RunPython(backfill_handed_over, noop_reverse),
    ]
