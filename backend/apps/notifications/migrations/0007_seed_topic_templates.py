"""feat/notifications-wiring: строки NotificationTemplate для реестра
settings.NOTIFICATION_TOPIC_TEMPLATES (config/settings/base.py — список и
обоснование по каждому топику там же) — без строки таблицы
apps.notifications.subscriber.handle_event молча отбрасывает событие с
warning-логом, даже если топик уже в реестре.

`body_i18n` этих строк ПУСТОЙ намеренно — источник текста для кодов-топиков
(code буквально равен outbox-топику) теперь языковой пакет (`apps.l10n`,
namespace `notifications.<topic>`, apps.notifications.selectors.render_body
пробует его первым) — дублировать текст ещё и здесь означало бы два
источника правды с риском разъехаться. body_i18n остаётся пустым fallback-
хвостом на случай, если пакет для locale ещё не импортирован (тогда
render_body отдаёт "" — не ошибка, см. её докстринг).

`signature_requested` — старый «прямой» шаблон (apps.contracts.services.
route_signatory/route_amendment_signatory зовут place_notification
напрямую, минуя topic-реестр, ещё до этой ветки), НЕ подключён к языковым
пакетам (code не топик) — для него, в отличие от кодов-топиков выше,
body_i18n заполнен сразу (ru/en), тем же приёмом, что уже сделали миграции
0005/0006 для milestone_submitted_for_acceptance/milestone_material_notice/
evidence_received — он был единственным «прямым» шаблоном без строки
вообще (обнаружено при подготовке этой ветки)."""

from __future__ import annotations

from django.db import migrations

# topic-коды (settings.NOTIFICATION_TOPIC_TEMPLATES) — body_i18n пуст, текст
# из l10n-пакета. legal_significance — по факту: юридически значимые
# события (подпись, приёмка, завершение, разногласие) — True; чисто
# информационные (отправка на согласование, правки, старт этапа) — False.
TOPIC_TEMPLATES: dict[str, bool] = {
    "negotiation.sent": False,
    "negotiation.revised": False,
    "negotiation.frozen": True,
    "negotiation.signed": True,
    "contract.signed": True,
    "milestone.started": False,
    "milestone.accepted": True,
    "milestone.auto_accepted": True,
    "milestone.rejected": True,
    "dispute.opened": True,
    "dispute.resolved": True,
    # contract.completed — НЕ topic-код в этом реестре (actor события
    # всегда пуст, settings.py докстринг), но того же семейства «код =
    # топик, текст из пакета» — используется прямым вызовом
    # place_notification в apps.contracts.services.complete_execution
    # (см. коммит), поэтому строка заводится здесь же.
    "contract.completed": True,
}

DIRECT_CALL_TEMPLATES = {
    "signature_requested": {
        "legal_significance": True,
        "body_i18n": {
            "ru": "Требуется ваша подпись.",
            "en": "Your signature is requested.",
        },
    },
}


def seed(apps, schema_editor):
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    for code, legal_significance in TOPIC_TEMPLATES.items():
        NotificationTemplate.objects.update_or_create(
            code=code, defaults={"legal_significance": legal_significance, "body_i18n": {}}
        )
    for code, fields in DIRECT_CALL_TEMPLATES.items():
        NotificationTemplate.objects.update_or_create(code=code, defaults=fields)


def unseed(apps, schema_editor):
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    NotificationTemplate.objects.filter(
        code__in=[*TOPIC_TEMPLATES, *DIRECT_CALL_TEMPLATES]
    ).delete()


class Migration(migrations.Migration):
    dependencies = [("notifications", "0006_seed_evidence_received_template")]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
