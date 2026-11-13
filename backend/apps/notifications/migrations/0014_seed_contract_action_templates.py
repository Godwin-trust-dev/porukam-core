"""ADR-126: строки NotificationTemplate для кодов, добавленных аудитом
«уведомления должны приходить по каждому действию по договору» — вторая
аудитория события (`settings.NOTIFICATION_TOPIC_COUNTERPARTY_TEMPLATES`) и
платёжный контур (`milestone.advance_confirmed/payment_confirmed/paid`,
которых не было ни в одном реестре — «уведомления не приходят при действиях
по оплате»).

Без строки таблицы `apps.notifications.subscriber._place` молча отбрасывает
событие с warning-логом, даже если топик уже в реестре — та же механика, что
у 0007_seed_topic_templates, и `body_i18n` здесь так же ПУСТОЙ: источник
текста для кодов-топиков — языковой пакет (`apps.l10n`, namespace
`notifications.<code>`, `apps.notifications.selectors.render_body` пробует
его первым), дублировать текст в БД значило бы два источника правды.

`legal_significance` — по факту: прекращение согласования, подпись, платёж,
расторжение, закрытие, вступление допника в силу — True; информационные
шаги (правки, отправка допника на согласование, материалы, возобновление
работ) — False. Тем же принципом, что 0007."""

from __future__ import annotations

from django.db import migrations

TEMPLATES: dict[str, bool] = {
    # Переговоры глазами контрагента.
    "negotiation.sent.counterparty": False,
    "negotiation.revised.proposed": False,
    "negotiation.revised.accepted": False,
    "negotiation.revised.rejected": False,
    "negotiation.withdrawn": True,
    "negotiation.rejected": True,
    "negotiation.reopened": True,
    "negotiation.signed.counterparty": True,
    "negotiation.signature_request_expired": True,
    # Жизненный цикл договора.
    "contract.amended": True,
    "amendment.sent": False,
    "contract.terminated": True,
    "contract.closed": True,
    # Этапы.
    "milestone.material_received": False,
    "milestone.resumed": False,
    # Оплата (главная дыра аудита 25.08).
    "milestone.advance_confirmed": True,
    "milestone.advance_confirmed.counterparty": True,
    "milestone.payment_confirmed": True,
    "milestone.payment_confirmed.counterparty": True,
    "milestone.paid": True,
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
    dependencies = [("notifications", "0013_notification_source_event_id")]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
