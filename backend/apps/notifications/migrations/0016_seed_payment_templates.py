"""ADR-130 (Э5): строки NotificationTemplate платёжного контура.

ADR-126 назвал эту дыру прямо: «Всё ещё нет события в домене — выставление
счёта, зачисление платежа, просрочка оплаты. apps.payments пуст; среди
DeadlineKindConfig нет платёжного вида, поэтому „просрочка оплаты“ не может
даже сработать свипом». Появился `Payment` — появились и события.

Подтверждений оплаты здесь НЕТ намеренно: `milestone.advance_confirmed`/
`payment_confirmed`/`paid` уже засеяны 0014 и продолжают публиковаться
(apps.payments зеркалит подтверждение в apps.milestones) — второй шаблон на
тот же момент дал бы человеку два уведомления об одном действии.

`body_i18n` пустой — источник текста языковой пакет (`notifications.<код>`),
как в 0007/0014.
"""

from __future__ import annotations

from django.db import migrations

TEMPLATES: dict[str, bool] = {
    # Юридически значимо: возникло денежное обязательство с сроком.
    "payment.created": True,
    "payment.overdue": True,
    "payment.cancelled": True,
    "payment.cancelled.counterparty": True,
}


def seed(apps, schema_editor):
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    for code, legal_significance in TEMPLATES.items():
        NotificationTemplate.objects.update_or_create(
            code=code, defaults={"legal_significance": legal_significance, "body_i18n": {}}
        )


def unseed(apps, schema_editor):
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    NotificationTemplate.objects.filter(code__in=list(TEMPLATES)).delete()


class Migration(migrations.Migration):
    dependencies = [("notifications", "0015_email_channel_off_by_default")]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
