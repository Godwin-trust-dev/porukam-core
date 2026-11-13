"""Сид длительностей этапа 7 (docs/plan.md «Споры и гарантия», ADR-131):
окна оспаривания (ADR-019).

`dispute_response_window` — срок ответа второй стороны на открытое
разногласие; `termination_dispute_window` — срок оспаривания расторжения
ИСПОЛНИТЕЛЕМ (ADR-028: «не свободное право, требует основания, проходит
через окно оспаривания»).

Значения: 7 суток обоим. Обоснование границ, а не «число из воздуха» —
окно обязано быть заметно короче потолка спора (30 дней, ADR-020: иначе
ответ приходил бы, когда разбирательство уже закрыто) и заметно длиннее
окна приёмки/материалов (48 ч: там сторона ждала действия и следит за ним,
а тут утверждение прилетает без предупреждения, и «не открывал ЛК неделю»
не должно стоить позиции). Как и `contract_warranty`/`signature_request_
expiry`, финальные значения — предмет согласования с юристом (tech-spec.md
§11 п.4); они и живут ДАННЫМИ в DeadlineKindConfig, чтобы правка не
требовала релиза кода."""

from datetime import timedelta

from django.db import migrations

DURATIONS = {
    "dispute_response_window": timedelta(days=7),
    "termination_dispute_window": timedelta(days=7),
}


def seed_kind_durations(apps, schema_editor):
    DeadlineKindConfig = apps.get_model("deadlines", "DeadlineKindConfig")
    for kind, duration in DURATIONS.items():
        DeadlineKindConfig.objects.update_or_create(kind=kind, defaults={"duration": duration})


def unseed_kind_durations(apps, schema_editor):
    DeadlineKindConfig = apps.get_model("deadlines", "DeadlineKindConfig")
    DeadlineKindConfig.objects.filter(kind__in=DURATIONS).delete()


class Migration(migrations.Migration):
    dependencies = [("deadlines", "0005_seed_payment_settlement")]

    operations = [
        migrations.RunPython(seed_kind_durations, unseed_kind_durations),
    ]
