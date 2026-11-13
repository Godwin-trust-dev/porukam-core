"""Этап 7 (docs/plan.md «Споры и гарантия», ADR-131): строки
`NotificationTemplate` для контура разногласий и гарантии.

Без строки таблицы `apps.notifications.subscriber._place` молча отбрасывает
событие с warning-логом, даже если топик уже в реестре — та же механика, что
у 0007/0014, и `body_i18n` здесь так же ПУСТОЙ: источник текста для
кодов-топиков — языковой пакет (`apps.l10n`, namespace
`notifications.<code>`, `apps.notifications.selectors.render_body` пробует
его первым). Тексты долиты во все 29 пакетов
(`l10n/patches/adr-131-disputes-warranty.json`).

Все коды НЕЙТРАЛЬНЫ к точке зрения («Запрошено исправление», «Предложена
скидка», «Срок ответа истёк»), поэтому суффикса `.counterparty` нет ни у
одного: правило именования ADR-126 §2 требует его только там, где текст
расходится («Ваша подпись принята» vs «Вторая сторона подписала»).

`legal_significance` — по факту: раунд исправления, предложение и отклонение
скидки, истечение окна оспаривания, потолок 30 дней и гарантийная претензия
меняют правовое положение сторон -> True; «получен ответ» и «возражение
подано» — информационные реплики диалога -> False."""

from __future__ import annotations

from django.db import migrations

TEMPLATES: dict[str, bool] = {
    # Раунды исправления (tech-spec.md §8.8).
    "dispute.fix_requested": True,
    "dispute.fix_resubmitted": True,
    # Реплики диалога.
    "dispute.responded": False,
    "dispute.window_contested": False,
    # Скидка = допник (§5.2.7, §20.3 анти-waiver).
    "dispute.discount_proposed": True,
    "dispute.discount_declined": True,
    # Системные исходы: ADR-019 (окно истекло молча) и ADR-020 (потолок).
    "dispute.window_expired": True,
    "dispute.cap_reached": True,
    # Гарантия (ADR-029/030) — отдельная метрика, рейтинг не трогает.
    "warranty.claim_submitted": True,
    "warranty.claim_resolved": True,
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
    dependencies = [("notifications", "0016_seed_payment_templates")]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
