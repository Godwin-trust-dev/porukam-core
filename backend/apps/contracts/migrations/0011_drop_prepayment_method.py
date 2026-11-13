"""ADR-155: способ расчёта `prepayment` упразднён.

Решение владельца 03.09, дословно: «способ оплаты — это каким способом
перемещаются деньги. предоплата с двусторонним подтверждением — там быть не
должно. Можешь смело удалять. порядок оплаты — постоплата (после приемки) и
предоплата (до начала этапа)». Предоплата — это СРОК, и с появлением
`Contract.payment_order` (ADR-151) способ стал вторым именем того же факта.

Данные. Мастер этот способ НИКОГДА не предлагал (`WIZARD_PAYMENT_METHODS`
на фронте — только `cash` и `external`), так что ожидаемое число строк —
ноль; миграция всё равно написана честно:

* ЧЕРНОВИКИ и договоры на согласовании (всё, что ещё не `signed`) —
  `payment_method` в NULL: способа с таким смыслом больше нет, а угадывать
  за человека («он имел в виду cash?») нельзя. Поле обязательно на `send`
  (`PaymentMethodRequiredError`), поэтому сторона просто выберет заново —
  это ровно тот же сценарий, что у договоров, созданных до появления поля.
* ПОДПИСАННЫЕ договоры НЕ ТРОГАЕМ. Способ расчёта входит в замороженную
  версию под `integrity_hash` (ADR-073): переписать его задним числом
  значило бы разойтись с подписанным текстом. Такие строки только считаются
  и выводятся в лог — с ними работают вручную (допником), если они вообще
  найдутся.

Откат: обратной операции нет — исходное значение не сохраняется. Понижение
кода до этой ветки вернёт `prepayment` в `choices`, но не в данные;
осмысленного отката у «человек выберет заново» не существует.
"""

from __future__ import annotations

import logging

from django.db import migrations, models

logger = logging.getLogger(__name__)

_PREPAYMENT = "prepayment"
_SIGNED = "signed"


def drop_prepayment_from_unsigned(apps, schema_editor):
    Contract = apps.get_model("contracts", "Contract")
    rows = Contract.objects.filter(payment_method=_PREPAYMENT)
    signed = rows.filter(negotiation_status=_SIGNED).count()
    cleared = rows.exclude(negotiation_status=_SIGNED).update(payment_method=None)
    logger.info(
        "ADR-155: способ prepayment снят у %s неподписанных договоров; "
        "подписанных с этим способом найдено %s (не изменены — заморожены под integrity_hash)",
        cleared,
        signed,
    )


def noop_reverse(apps, schema_editor):
    """Исходное значение не сохранялось — восстанавливать нечего."""


class Migration(migrations.Migration):
    dependencies = [
        ("contracts", "0010_contract_payment_order"),
    ]

    operations = [
        migrations.RunPython(drop_prepayment_from_unsigned, noop_reverse),
        migrations.AlterField(
            model_name="contract",
            name="payment_method",
            field=models.CharField(
                blank=True,
                choices=[
                    ("direct_platform", "Прямой платёж (наблюдение платформой)"),
                    ("hold", "Холд (Р2)"),
                    ("cash", "Наличные"),
                    ("external", "Внешний перевод"),
                ],
                max_length=16,
                null=True,
            ),
        ),
    ]
