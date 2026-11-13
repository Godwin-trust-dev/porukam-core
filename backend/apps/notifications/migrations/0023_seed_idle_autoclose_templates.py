"""ADR-138 (автозакрытие сделок без движения, ADR-137 требование 8):
шаблоны трёх уведомлений и серия напоминаний дедлайна `contract_idle`.

- `contract.idle_warning` — предупреждение обеим сторонам за две недели до
  автозакрытия; НЕ outbox-топик, а шаблон серии напоминаний
  (`ReminderPointConfig(kind="contract_idle")`, тот же механизм, что
  `milestone_acceptance_reminder`). Точка серии — доля интервала
  `anchor_at..deadline_at`: 76/90 при сроке 90 суток (deadlines/0008) даёт
  ровно 14 суток до закрытия; при смене срока точку пересчитать здесь же.
- `contract.idle_blocked` — отсрочка на `contract_idle_retry`: в момент
  срабатывания у договора есть незавершённые действия сторон.
- `contract.auto_closed` — договор закрыт автоматически.

Все три юрзначимы (`legal_significance=True`): предупреждение — условие
самого автозакрытия (ADR-137), закрытие меняет правовое положение сторон
и запускает цикл хранения. Тот же приём, что 0017/0018: `body_i18n` ПУСТОЙ,
текст — из языковых пакетов (`l10n/patches/adr-138-idle-autoclose.json`,
все 29 языков). Коды нейтральны к точке зрения — суффикса `.counterparty`
нет (ADR-126 §2)."""

from __future__ import annotations

from django.db import migrations

TEMPLATES: dict[str, bool] = {
    "contract.idle_warning": True,
    "contract.idle_blocked": True,
    "contract.auto_closed": True,
}

# 14 суток до закрытия при сроке 90 суток (deadlines/0008): 1 - 14/90.
IDLE_WARNING_POINT = 1 - 14 / 90

REMINDER_POINTS = {
    "contract_idle": {
        "template": "contract.idle_warning",
        "points": [IDLE_WARNING_POINT],
    },
}


def seed(apps, schema_editor):
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    for code, legal_significance in TEMPLATES.items():
        NotificationTemplate.objects.update_or_create(
            code=code, defaults={"legal_significance": legal_significance, "body_i18n": {}}
        )
    ReminderPointConfig = apps.get_model("notifications", "ReminderPointConfig")
    for kind, fields in REMINDER_POINTS.items():
        ReminderPointConfig.objects.update_or_create(kind=kind, defaults=fields)


def unseed(apps, schema_editor):
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    NotificationTemplate.objects.filter(code__in=list(TEMPLATES)).delete()
    ReminderPointConfig = apps.get_model("notifications", "ReminderPointConfig")
    ReminderPointConfig.objects.filter(kind__in=list(REMINDER_POINTS)).delete()


class Migration(migrations.Migration):
    dependencies = [("notifications", "0022_reminder_schedule_recipient_unique")]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
