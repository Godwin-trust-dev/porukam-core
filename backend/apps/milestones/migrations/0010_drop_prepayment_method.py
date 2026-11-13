"""ADR-155: контур аванса снят целиком — колонок
`Milestone.advance_confirmed_by_*_at` больше нет.

Они были зеркалом «аванса» — второго платежа по листу, который существовал
только ради способа `payment_method=prepayment` (упразднён в
`contracts 0011`). Предоплата теперь — это `payment_order=before_start`, и
платёж по листу у неё ОДИН, зеркалится в `paid_confirmed_*_at`.

Колонки удаляются, а не оставляются мёртвыми: DROP COLUMN в PostgreSQL —
операция уровня каталога (метка «удалено» в pg_attribute, без переписывания
таблицы и без долгой блокировки), а мёртвая колонка на юрзначимой таблице
живёт вечно и однажды будет прочитана как факт. Данных в них не было: аванс
выставлялся только договорам со способом `prepayment`, которого мастер
никогда не предлагал (см. лог `contracts 0011`).
"""

from __future__ import annotations

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("milestones", "0009_material_two_sided_handover"),
        # Сначала способ исчезает из договоров, потом — его зеркало на
        # этапе (читаемость истории).
        ("contracts", "0011_drop_prepayment_method"),
        # ОБЯЗАТЕЛЬНО: `payments 0002` читает `advance_confirmed_*` через
        # историческую модель. Без этой зависимости планировщик вправе
        # поставить удаление колонок РАНЬШЕ бэкфилла — и тот упадёт на
        # несуществующем поле.
        ("payments", "0002_backfill_from_milestone_confirmations"),
    ]

    operations = [
        migrations.RemoveField(
            model_name="milestone",
            name="advance_confirmed_by_contractor_at",
        ),
        migrations.RemoveField(
            model_name="milestone",
            name="advance_confirmed_by_customer_at",
        ),
    ]
