"""Use cases apps.payments — Э5 волна 1 (ADR-130): выставление платежа по
денежному листу, двустороннее подтверждение, отмена, просрочка.

ГЛАВНОЕ ПРАВИЛО ЗАВИСИМОСТЕЙ (ADR-130): `apps.payments` вызывает
`apps.milestones`, но НИКОГДА наоборот. Причина не стилистическая:
`apps.contracts.services` статически импортирует `apps.milestones.services`
(`freeze_contract`/`apply_amendment`/`effective_terms`), поэтому любой
импорт `apps.payments` внутри `apps.milestones` протащил бы цепочку
`apps.contracts -> apps.milestones -> apps.payments` и сломал бы контракт
import-linter «contracts не импортирует payments» (pyproject.toml). Тот же
приём разрыва, что `apps.disputes` применяет к `apps.milestones`.

Следствие для «гейта от Payment»: `Payment` — ИСТОЧНИК ПРАВДЫ о деньгах,
а отметки `Milestone.paid_confirmed_*_at` — денормализованное ЗЕРКАЛО,
которое пишется ИСКЛЮЧИТЕЛЬНО отсюда (единственный путь записи —
HTTP-эндпоинты apps.payments.api, включая унаследованный
`/milestones/{id}/confirm-payment`, переехавший в это приложение вместе с
ответственностью). Зеркало нужно, чтобы
`apps.milestones.services._financial_condition` (гейт §6.3) и
`apps.dashboards.selectors._payment_state` продолжали считать финансовое
условие, НЕ импортируя apps.payments — то есть без нарушения контракта.
Расхождения между Payment и зеркалом быть не может: обе записи в одной
транзакции, и вторая невозможна без первой.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any

from django.db import transaction
from django.utils import timezone

from apps.accounts.models import User
from apps.contracts import selectors as contracts_selectors
from apps.contracts import services as contracts_services
from apps.contracts.models import Contract, ContractParty
from apps.deadlines import selectors as deadlines_selectors
from apps.deadlines import services as deadlines_services
from apps.milestones import services as milestones_services
from apps.milestones.models import Milestone
from common import outbox
from common.fsm import StateMachine, Transition
from common.money import Money

from .models import Payment
from .providers import (
    PaymentFlow,
    PaymentProviderNotConfiguredError,
    get_provider,
)

_STATUS = Payment.Status
_KIND = Payment.Kind
_METHOD = Payment.Method
_ROLE = ContractParty.Role

#: Роли сторон в деньгах. Заказчик платит, исполнитель получает — во всех
#: типах договоров каталога (в займе «заказчик» — заёмщик, возвращающий
#: деньги по графику: `materialize_loan_schedule` кладёт платежи графика
#: этапами того же договора, роли не переворачиваются).
PAYER_ROLE = _ROLE.CUSTOMER
PAYEE_ROLE = _ROLE.CONTRACTOR

#: Категория дедлайна оплаты (строка в БД + свип каждую минуту, CLAUDE.md —
#: НЕ отложенная Celery-задача). Длительность — данные, миграция
#: `deadlines/0005_seed_payment_settlement`.
PAYMENT_DEADLINE_KIND = "payment_settlement"
PAYMENT_DEADLINE_SUBJECT = "payment"

PAYMENT_FSM = StateMachine(
    states=[s.value for s in _STATUS],
    transitions=[
        # Двустороннее подтверждение (tech-spec.md §8.7 `/payments/{id}/
        # confirm` c `{"side": "payer"|"payee"}`): порядок сторон не задан,
        # первым может отметиться любой — отсюда два «полупути» в
        # `confirmed`, а не линейная цепочка.
        Transition("confirm_payer", _STATUS.PENDING, _STATUS.PAYER_CONFIRMED),
        Transition("confirm_payer", _STATUS.PAYEE_CONFIRMED, _STATUS.CONFIRMED),
        Transition("confirm_payee", _STATUS.PENDING, _STATUS.PAYEE_CONFIRMED),
        Transition("confirm_payee", _STATUS.PAYER_CONFIRMED, _STATUS.CONFIRMED),
        # Отмена — ТОЛЬКО из `pending`. Как только сторона зафиксировала
        # денежный факт, обратный ход — это возврат (`refund`, Р2, нужен
        # партнёр), а не отмена счёта; иначе отмена молча обнулила бы уже
        # сделанное подтверждение и рассинхронизировала зеркало на Milestone.
        Transition("cancel", _STATUS.PENDING, _STATUS.CANCELLED),
    ],
)


class PaymentSideMismatchError(ValueError):
    """`side` подтверждения не совпадает с ролью вызывающего в договоре —
    нельзя подтвердить «за контрагента» (симметрично
    `apps.milestones.services.WrongConfirmationSideError`, свой тип, потому
    что HTTP-код и текст принадлежат платёжному контуру)."""


class MilestoneNotPayableError(ValueError):
    """Платёж возможен только по ДЕНЕЖНОМУ ЛИСТУ дерева этапов: у ветки
    суммы нет по инварианту `milestone_amount_guard` (CLAUDE.md: «ветки
    группируют, ЛИСТЬЯ принимаются/оплачиваются»)."""


class ContractNotSignedError(ValueError):
    """Счёт по неподписанному договору не выставляется — обязательства
    возникают со второй подписи (tech-spec.md §6.1)."""


class PaymentNotCancellableError(ValueError):
    """ADR-132, распространено ADR-155: счёт, который является УСЛОВИЕМ
    ГЕЙТА этапа (оплата до старта при `payment_order=before_start`, §6.3),
    НЕ отменяется. `UNIQUE (milestone, kind)` не даст выставить его заново,
    то есть отменённый счёт запер бы старт этапа навсегда. Ошибочные условия
    лечатся допником (смена порядка оплаты), не отменой счёта.

    Прежнее имя — `AdvanceNotCancellableError`: правило заводилось для вида
    `advance`, упразднённого ADR-155 вместе со способом `prepayment`; смысл
    целиком перешёл на предоплатный счёт."""


def _now() -> datetime:
    return timezone.now()


def _money(milestone: Milestone) -> Money:
    if milestone.amount is None or not milestone.amount_currency:
        raise MilestoneNotPayableError(f"этап {milestone.id} без суммы — платить нечего")
    return Money(milestone.amount, milestone.amount_currency)


def _assert_leaf(milestone: Milestone) -> None:
    if milestone.children.exists():
        raise MilestoneNotPayableError(f"этап {milestone.id} — ветка дерева, не лист")


def _event_payload(payment: Payment, **extra: Any) -> dict[str, Any]:
    """Самодостаточный payload (док 31 §7, ADR-098): событие несёт всё,
    что нужно и уведомлению, и Audit Vault, и будущей аналитике — читать
    таблицы задним числом они не обязаны. `amount` — СТРОКОЙ (CLAUDE.md:
    суммы в API строкой; float в JSON потерял бы копейки)."""
    milestone = payment.milestone
    payload: dict[str, Any] = {
        "payment_id": str(payment.id),
        "contract_id": str(payment.contract_id),
        "milestone_id": str(payment.milestone_id),
        "milestone_title": milestone.title,
        "kind": payment.kind,
        "method": payment.method,
        "status": payment.status,
        "amount": str(payment.amount),
        "currency": payment.currency,
        "parties": contracts_selectors.party_identity_snapshot(payment.contract),
        "occurred_at": _now().isoformat(),
    }
    payload.update(extra)
    return payload


def _subject(payment: Payment) -> dict[str, Any]:
    """`contract_id` рядом с собственным id — ADR-126 резолвит стороны
    договора для «второй аудитории» уведомления именно отсюда."""
    return {
        "type": "payment",
        "id": str(payment.id),
        "contract_id": str(payment.contract_id),
    }


def _publish(payment: Payment, topic: str, *, user: User | None = None, **extra: Any) -> None:
    outbox.publish(
        topic,
        subject=_subject(payment),
        payload=_event_payload(payment, **extra),
        actor={"user_id": str(user.id)} if user is not None else {},
    )


def assert_method_supported(method: str) -> None:
    """Способы `direct_platform`/`hold` требуют платёжного партнёра, которого
    нет (ADR-130) — `409 payment_provider_not_configured`. Отбиваем ДО
    создания строки: платёж в `pending`, который никто никогда не сможет
    подтвердить, хуже честной ошибки."""
    if method in Payment.PROVIDER_METHODS:
        raise PaymentProviderNotConfiguredError(
            f"способ расчёта {method!r} требует платёжного партнёра — он не подключён"
        )


def payment_flow(payment: Payment) -> PaymentFlow:
    """tech-spec.md §8.7: «платёжная ссылка/QR СБП провайдера». У прямого
    платежа ссылки нет — provider возвращает `kind="two_sided"`."""
    provider = get_provider(payment.provider)
    return provider.create_payment(
        amount=str(payment.amount), currency=payment.currency, reference=str(payment.id)
    )


@transaction.atomic
def create_payment(
    milestone: Milestone, *, kind: str, actor_user: User | None = None
) -> tuple[Payment, bool]:
    """Выставление к оплате. Возвращает `(payment, created)` — вызывающая
    сторона (подписчик outbox, read-repair в GET, унаследованный эндпоинт)
    может звать её сколько угодно раз: идемпотентность даёт
    `UNIQUE (milestone, kind)`, а не память вызывающего.

    Дедлайн оплаты — СТРОКА в apps.deadlines (CLAUDE.md), `starts_from=event`
    и якорь сразу: юрканал ЛК (ADR-057) якорит от размещения уведомления там,
    где от размещения считается ПРАВО стороны (приёмка, подпись); срок
    оплаты же отсчитывается от момента возникновения денежного
    обязательства, и «сторона не открывала ЛК» его не двигает.
    """
    contract = milestone.contract
    if contract.negotiation_status != Contract.NegotiationStatus.SIGNED:
        raise ContractNotSignedError(
            f"договор {contract.id} в статусе {contract.negotiation_status!r}, не signed"
        )
    _assert_leaf(milestone)
    money = _money(milestone)
    method = contract.payment_method or ""
    assert_method_supported(method)

    payment, created = Payment.objects.get_or_create(
        milestone=milestone,
        kind=kind,
        defaults={
            "contract": contract,
            "method": method,
            "status": _STATUS.PENDING,
            "amount": money.amount,
            "currency": money.currency,
            "provider": Payment.PROVIDER_MANUAL,
        },
    )
    if not created:
        return payment, False

    deadlines_services.create_deadline(
        kind=PAYMENT_DEADLINE_KIND,
        subject_type=PAYMENT_DEADLINE_SUBJECT,
        subject_id=payment.id,
        starts_from="event",
        anchor_at=payment.created_at or _now(),
    )
    _publish(payment, "payment.created", user=actor_user)
    return payment, True


def _payable_leaves(contract: Contract) -> list[Milestone]:
    """Денежные листья договора. `children__isnull=True` по обратному FK —
    ровно определение листа (`apps.milestones.selectors.build_tree` строит
    то же дерево, но ему нужны и ветки)."""
    return list(
        Milestone.objects.filter(
            contract=contract, amount__isnull=False, children__isnull=True
        ).order_by("order", "id")
    )


def payment_before_start(contract: Contract) -> bool:
    """Фасад над `apps.milestones.services.payment_before_start` (ADR-155):
    порядок оплаты — условие ДОГОВОРА, но его следствие для листа считает
    apps.milestones (там же гейт §6.3), и второе место, где это правило
    «знают», заводить нельзя."""
    return milestones_services.payment_before_start(contract)


@transaction.atomic
def ensure_contract_payments(contract: Contract) -> list[Payment]:
    """Материализация счетов договора:

    - `payment_order=before_start` (ADR-155) — счёт на КАЖДЫЙ денежный лист
      сразу после подписания, независимо от статуса листа: этот счёт и есть
      условие старта (§6.3), значит существовать он обязан РАНЬШЕ, чем лист
      попробует стартовать;
    - `after_acceptance` — как было: счёт на лист, дошедший до
      `accepted`/`paid`.

    Вид платежа один и тот же (`postpayment` — «оплата этапа»): вид не
    называет срок, срок называет `Contract.payment_order`. Отдельного
    «аванса» больше нет — он был вторым именем той же оплаты того же листа
    (ADR-155, упразднён вместе со способом `payment_method=prepayment`).

    Зачем нужна вдобавок к подписчику outbox (`handlers.handle_event`):
    реле доставляет события ФОНОВЫМ свипом (ADR-064), а карточка договора
    открывается сразу после приёмки. Без этого вызова фронт увидел бы
    пустой список платежей и «подтвердить» было бы нечего до следующего
    прогона Celery. Операция идемпотентна (`UNIQUE (milestone, kind)`),
    поэтому «read-repair» на GET безопасен и не удваивает событий.
    """
    if contract.negotiation_status != Contract.NegotiationStatus.SIGNED:
        return []
    if (contract.payment_method or "") not in Payment.TWO_SIDED_METHODS:
        # direct_platform/hold — партнёра нет, счетов не выставляем вовсе
        # (гейт остаётся `awaiting_payment`, как и до Э5).
        return []
    before_start = payment_before_start(contract)
    result: list[Payment] = []
    for leaf in _payable_leaves(contract):
        if before_start or leaf.status in (Milestone.Status.ACCEPTED, Milestone.Status.PAID):
            payment, _ = create_payment(leaf, kind=_KIND.POSTPAYMENT)
            result.append(payment)
    return result


def role_of(payment: Payment, user: User) -> str:
    """Роль пользователя в договоре платежа (403, если он не сторона)."""
    party = contracts_services.get_party_for_user(payment.contract, user)
    return str(party.role)


def side_of(role: str) -> str:
    return "payer" if role == PAYER_ROLE else "payee"


def _mirror_into_milestone(payment: Payment, *, user: User, role: str) -> None:
    """Единственная точка записи денежного зеркала на Milestone (см.
    докстринг модуля). `confirm_payment` сама проверяет роль, статус этапа
    и публикует `milestone.*`-события, на которых уже висят уведомления
    ADR-126 и репутация ГВ.4 — переписывать их здесь значило бы завести
    второй источник тех же фактов. Развилки по виду платежа больше нет:
    вид один (ADR-155).

    ADR-163 §6: сюда же добавлен `payment_due_at` — срок оплаты по
    категории `payment_settlement`. Его знает ТОЛЬКО apps.payments (дедлайн
    висит на `Payment`), а нужен он в событии `milestone.payment_confirmed`,
    которое публикует apps.milestones; обратный импорт запрещён контрактом
    import-linter, поэтому срок едет параметром по тем же рельсам, что и
    само зеркало."""
    deadline = deadlines_selectors.latest_deadline_for_subject(
        kind=PAYMENT_DEADLINE_KIND, subject_type=PAYMENT_DEADLINE_SUBJECT, subject_id=payment.id
    )
    milestones_services.confirm_payment(
        payment.milestone,
        user=user,
        side=role,
        payment_due_at=deadline.deadline_at if deadline is not None else None,
    )


@transaction.atomic
def confirm_by_payer(payment: Payment, *, user: User) -> Payment:
    """`side=payer`. Повтор той же стороной — НЕ 409, а no-op с текущим
    состоянием: кнопка «оплатил» переживает двойной клик и ретрай сети, а
    денежного факта второе нажатие не добавляет (ровно то же поведение,
    что было у `/milestones/{id}/confirm-payment` до Э5 — ломать его на
    409 значило бы менять контракт фронта без причины)."""
    role = role_of(payment, user)
    if role != PAYER_ROLE:
        raise PaymentSideMismatchError(
            f"пользователь {user.id} действует как {role!r} — плательщик здесь {PAYER_ROLE!r}"
        )
    if payment.payer_confirmed_at is not None:
        return payment
    transition = PAYMENT_FSM.assert_transition("confirm_payer", payment.status)
    _mirror_into_milestone(payment, user=user, role=role)
    payment.payer_confirmed_at = _now()
    payment.status = transition.target
    payment.save(update_fields=["payer_confirmed_at", "status"])
    _publish(payment, "payment.payer_confirmed", user=user, side="payer")
    if payment.status == _STATUS.CONFIRMED:
        _publish(payment, "payment.paid", user=user)
    return payment


@transaction.atomic
def confirm_by_payee(payment: Payment, *, user: User) -> Payment:
    """`side=payee` — зеркально `confirm_by_payer`."""
    role = role_of(payment, user)
    if role != PAYEE_ROLE:
        raise PaymentSideMismatchError(
            f"пользователь {user.id} действует как {role!r} — получатель здесь {PAYEE_ROLE!r}"
        )
    if payment.payee_confirmed_at is not None:
        return payment
    transition = PAYMENT_FSM.assert_transition("confirm_payee", payment.status)
    _mirror_into_milestone(payment, user=user, role=role)
    payment.payee_confirmed_at = _now()
    payment.status = transition.target
    payment.save(update_fields=["payee_confirmed_at", "status"])
    _publish(payment, "payment.payee_confirmed", user=user, side="payee")
    if payment.status == _STATUS.CONFIRMED:
        _publish(payment, "payment.paid", user=user)
    return payment


def confirm(payment: Payment, *, user: User, side: str | None = None) -> Payment:
    """`POST /v1/payments/{id}/confirm` — сторона определяется по роли
    вызывающего в договоре; явный `side` в теле, если передан, обязан с
    ней совпасть (tech-spec.md §8.7 объявляет поле — сохраняем контракт,
    но не позволяем им подменять личность)."""
    role = role_of(payment, user)
    resolved = side_of(role)
    if side is not None and side != resolved:
        raise PaymentSideMismatchError(
            f"пользователь {user.id} — {resolved!r} этого платежа, не {side!r}"
        )
    if role == PAYER_ROLE:
        return confirm_by_payer(payment, user=user)
    return confirm_by_payee(payment, user=user)


@transaction.atomic
def cancel_payment(payment: Payment, *, user: User, reason: str = "") -> Payment:
    """Отзыв ошибочно выставленного счёта. Любой стороной: счёт — не
    односторонняя претензия, а техническая запись «к оплате», и заказчик
    вправе снять её так же, как исполнитель.

    Только ПОСТОПЛАТА: счёт при `payment_order=before_start` отменять нельзя
    (ADR-132, ADR-155) — он условие гейта §6.3, повторно выставить его не
    даст `UNIQUE (milestone, kind)`, и старт этапа остался бы запертым
    навсегда. Проверка ДО FSM: это запрет по УСЛОВИЯМ ДОГОВОРА, а не по
    статусу платежа, и код ошибки у него свой (`409
    payment_not_cancellable`), а не `invalid_payment_transition`."""
    role_of(payment, user)  # 403, если не сторона
    if payment_before_start(payment.contract):
        raise PaymentNotCancellableError(
            f"платёж {payment.id}: оплата до начала этапа — условие гейта, "
            f"отмена невозможна (ADR-155)"
        )
    transition = PAYMENT_FSM.assert_transition("cancel", payment.status)
    payment.status = transition.target
    payment.cancelled_at = _now()
    payment.cancel_reason = reason[:255]
    payment.save(update_fields=["status", "cancelled_at", "cancel_reason"])
    _publish(payment, "payment.cancelled", user=user, reason=payment.cancel_reason)
    return payment


@transaction.atomic
def mark_overdue(payment: Payment) -> bool:
    """Срок оплаты вышел (свип `apps.deadlines`). Просрочка — НЕ переход
    FSM: платёж остаётся `pending` и подлежит оплате, меняется лишь факт
    «срок вышел» (`overdue_at`). Идемпотентно: повторная доставка события
    дедлайна (ADR-064, at-least-once) второго уведомления не породит."""
    if payment.status in Payment.TERMINAL_STATUSES or payment.overdue_at is not None:
        return False
    payment.overdue_at = _now()
    payment.save(update_fields=["overdue_at"])
    _publish(payment, "payment.overdue")
    return True


def total_confirmed(contract: Contract, *, kind: str = _KIND.POSTPAYMENT) -> Money | None:
    """Сумма подтверждённых платежей договора — property-based инвариант
    «полностью оплаченный договор = сумма его денежных листьев»
    (docs/plan.md Э5). `None` у договора без подтверждённых платежей:
    валюты по умолчанию нет (CLAUDE.md), выдумывать её для нуля нельзя."""
    rows = list(
        Payment.objects.filter(contract=contract, kind=kind, status=_STATUS.CONFIRMED).values_list(
            "amount", "currency"
        )
    )
    if not rows:
        return None
    total = Money(Decimal("0"), rows[0][1])
    for amount, currency in rows:
        total = total + Money(amount, currency)
    return total
