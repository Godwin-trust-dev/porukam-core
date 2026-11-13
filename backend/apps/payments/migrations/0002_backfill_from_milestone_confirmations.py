"""ADR-130: перенос уже состоявшихся денежных фактов из отметок на этапе в
модель `Payment`.

Зачем это НЕ «данные-заглушка для красоты»: с этой ветки гейт `accepted ->
paid` проходит только через `apps.payments.services`, а тот сначала
материализует счёт (`create_payment`). Договор, у которого одна сторона уже
нажала «оплатил» ДО выкладки, без переноса получил бы новый `pending`-платёж
с нулём подтверждений — человеку пришлось бы подтверждать заново, а лента ЛК
показала бы «выставлен счёт» по этапу, который стороны считают закрытым.

Что переносится: денежные ЛИСТЬЯ подписанных договоров со способом расчёта
без платёжного партнёра (`prepayment`/`cash`/`external`). Постоплата — у
листьев, дошедших до `accepted`/`paid`; аванс — только у `prepayment`.
Статус выводится из тех же двух меток, что читал гейт.

Что НЕ делается сознательно:
1. Событий в outbox нет. Это исторические факты, а не происходящие сейчас:
   опубликовать их значило бы разослать обеим сторонам уведомления
   «выставлен счёт»/«оплачено» по давно закрытым этапам (юрканал ЛК,
   ADR-057 — там каждое размещение считается доставкой).
2. Строк `DomainDeadline` нет. Дедлайн оплаты отсчитывается от выставления
   счёта; у перенесённых он вышел бы в прошлом, и первый же свип объявил бы
   просрочку по уже оплаченному.
3. `direct_platform`/`hold` пропускаются: платежей по ним не было и быть не
   могло (гейт их не пропускал), выдумывать записи не из чего.

Обратная миграция удаляет ровно перенесённые строки (`provider=manual` и
отсутствие `provider_ref`) — платежи, созданные после выкладки, отличаются
от них только временем, поэтому откат ограничен окном до первой записи
приложения и честно об этом сообщает: он для «раскатили-откатили», не для
«поработали месяц и откатили».
"""

from __future__ import annotations

from django.db import migrations

_OFFLINE_METHODS = ("prepayment", "cash", "external")
_PAYABLE_STATUSES = ("accepted", "paid")


def _status_for(payer_at, payee_at, *, force_confirmed: bool) -> str:
    if force_confirmed or (payer_at is not None and payee_at is not None):
        return "confirmed"
    if payer_at is not None:
        return "payer_confirmed"
    if payee_at is not None:
        return "payee_confirmed"
    return "pending"


def backfill(apps, schema_editor):
    Milestone = apps.get_model("milestones", "Milestone")
    Payment = apps.get_model("payments", "Payment")

    leaves = (
        Milestone.objects.filter(
            children__isnull=True,
            amount__isnull=False,
            contract__negotiation_status="signed",
            contract__payment_method__in=_OFFLINE_METHODS,
        )
        .select_related("contract")
        .order_by("contract_id", "order")
    )
    for leaf in leaves:
        method = leaf.contract.payment_method
        common = {
            "contract_id": leaf.contract_id,
            "method": method,
            "amount": leaf.amount,
            "currency": leaf.amount_currency,
            "provider": "manual",
        }
        if method == "prepayment":
            # Аванс — условие гейта: он существует у КАЖДОГО денежного листа
            # такого договора, даже если стороны ещё не подтверждали.
            Payment.objects.get_or_create(
                milestone_id=leaf.id,
                kind="advance",
                defaults={
                    **common,
                    "status": _status_for(
                        leaf.advance_confirmed_by_customer_at,
                        leaf.advance_confirmed_by_contractor_at,
                        force_confirmed=False,
                    ),
                    "payer_confirmed_at": leaf.advance_confirmed_by_customer_at,
                    "payee_confirmed_at": leaf.advance_confirmed_by_contractor_at,
                },
            )
        if leaf.status not in _PAYABLE_STATUSES:
            continue
        Payment.objects.get_or_create(
            milestone_id=leaf.id,
            kind="postpayment",
            defaults={
                **common,
                # `status=paid` — это и есть «обе стороны подтвердили»
                # (единственный путь в него до ADR-130 шёл через
                # confirm_payment с обеими отметками); отметки на всякий
                # случай не перепроверяем — статус этапа юридически старше.
                "status": _status_for(
                    leaf.paid_confirmed_by_customer_at,
                    leaf.paid_confirmed_by_contractor_at,
                    force_confirmed=leaf.status == "paid",
                ),
                "payer_confirmed_at": leaf.paid_confirmed_by_customer_at,
                "payee_confirmed_at": leaf.paid_confirmed_by_contractor_at,
            },
        )


def unbackfill(apps, schema_editor):
    Payment = apps.get_model("payments", "Payment")
    Payment.objects.filter(provider="manual", provider_ref__isnull=True).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("payments", "0001_initial"),
        ("milestones", "0006_merge_amount_guard_and_tutoring_repoint"),
    ]

    operations = [
        migrations.RunPython(backfill, unbackfill),
    ]
