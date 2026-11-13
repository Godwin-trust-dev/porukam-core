"""Use cases apps.milestones — Э4.3 (docs/tasks/etap-4.md): дерево этапов,
чек-листы, материалы. Заморозка/подписание (Э4.4) здесь не реализуются —
`assert_leaf_sum_matches` только ПРОВЕРЯЕТ (сервис проверки, вызывается
Э4.4 из freeze-флоу), само действие валидации на заморозке не запускает.

Редактирование структуры (Milestone/ChecklistItem/ContractMaterial) до
подписания — только пока договор draft/under_review (до `pending_signature`,
`_assert_editable`); после подписания единственный легитимный путь —
`apply_amendment_*` (Э4.5, вызывается ИСКЛЮЧИТЕЛЬНО из
`apps.contracts.services.apply_amendment` на второй подписи допника,
`contract.negotiation_status=signed` — `_assert_editable` СОЗНАТЕЛЬНО не
проверяется в этих функциях, легитимность решения несёт FSM допника, не
Contract.negotiation_status). `_create_milestone`/`_create_material` —
приватное общее ядро, которое `create_milestone`/`create_material`
(гейт + пользователь) и `apply_amendment_milestone_add`/
`apply_amendment_material_add` (без гейта, `created_by_amendment`)
переиспользуют одинаково — не копия валидации родителя/глубины/суммы.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any
from uuid import UUID

from django.db import transaction
from django.db.models import QuerySet
from django.utils import timezone

from apps.accounts.models import User
from apps.catalog import selectors as catalog_selectors
from apps.catalog import services as catalog_services
from apps.catalog.models import Currency, MaterialCatalogItem, Sphere
from apps.contracts import selectors as contracts_selectors
from apps.contracts import services as contracts_services
from apps.contracts.models import Amendment, Contract, ContractParty
from apps.deadlines import selectors as deadlines_selectors
from apps.deadlines import services as deadlines_services
from apps.notifications import services as notifications_services
from common import outbox
from common.fsm import StateMachine, Transition
from common.money import Money, assert_single_currency

from . import selectors
from .models import MAX_TREE_DEPTH, ChecklistItem, ContractMaterial, Milestone

_EDITABLE_NEGOTIATION_STATUSES = frozenset(
    {Contract.NegotiationStatus.DRAFT, Contract.NegotiationStatus.UNDER_REVIEW}
)
_SOURCE = ContractMaterial.Source
_ROLE = ContractParty.Role
_STATUS = Milestone.Status
_PAYMENT_METHOD = Contract.PaymentMethod
_PAYMENT_ORDER = Contract.PaymentOrder

# --- Э4.6: исполнение — гейт/сдача/приёмка (tech-spec.md §6.3) --------------
#
# `submit`/`reject` — «отклонён» ведёт в `disputed`, «принят» — в `accepted`
# ЛИБО напрямую (`accept`), ЛИБО из спора (`accept` из `disputed` — исход
# «диалог/согласие», apps.disputes.services.resolve_dispute, событие
# `dispute.resolved` -> apps.milestones.handlers -> тот же переход, разный
# источник — тот же приём, что `(name, source)`-ключ StateMachine различает
# `sign` из разных состояний в apps.contracts.NEGOTIATION_FSM).
MILESTONE_FSM = StateMachine(
    states=[s.value for s in _STATUS],
    transitions=[
        Transition("start", _STATUS.PENDING, _STATUS.IN_PROGRESS),
        Transition("suspend", _STATUS.IN_PROGRESS, _STATUS.SUSPENDED),
        Transition("resume", _STATUS.SUSPENDED, _STATUS.IN_PROGRESS),
        Transition("submit", _STATUS.IN_PROGRESS, _STATUS.UNDER_ACCEPTANCE),
        Transition("accept", _STATUS.UNDER_ACCEPTANCE, _STATUS.ACCEPTED),
        Transition("reject", _STATUS.UNDER_ACCEPTANCE, _STATUS.DISPUTED),
        Transition("accept", _STATUS.DISPUTED, _STATUS.ACCEPTED),
        # Этап 7 (ADR-131): исполнитель сдал исправление по раунду спора —
        # этап снова на приёмке (tech-spec.md §8.8: «Исправление сдано ->
        # снова under_acceptance»). Инициируется НЕ отсюда, а подписчиком
        # `handlers.handle_dispute_fix_resubmitted` на топик
        # `dispute.fix_resubmitted` — apps.disputes не зовёт
        # apps.milestones.services (тот же разрыв цикла, что у `reject`).
        Transition("resubmit_fix", _STATUS.DISPUTED, _STATUS.UNDER_ACCEPTANCE),
        Transition("pay", _STATUS.ACCEPTED, _STATUS.PAID),
    ],
)

_ACCEPTANCE_DEADLINE_KIND = "milestone_acceptance"
# ADR-140: окно приёмки — из условий договора (`form_data.acceptance_window_hours`,
# блок K7 формы услуг), а не только из длительности категории. Поле есть не у всех
# типов (продажа/аренда/заём — нет) и может отсутствовать в старых договорах — тогда
# длительность категории (48 ч, deadlines 0002). form_data после подписания не
# меняется (входит в snapshot замороженной версии), поэтому читаем с договора.
_ACCEPTANCE_WINDOW_FIELD = "acceptance_window_hours"


def _acceptance_window(contract: Contract) -> timedelta | None:
    raw = (contract.form_data or {}).get(_ACCEPTANCE_WINDOW_FIELD)
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 1:
        return None
    return timedelta(hours=raw)


# `DomainDeadline.outcome` при досрочном закрытии окна приёмки решением
# заказчика (`_close_acceptance_window`); срабатывание по свипу пишет
# `timed_out` (apps.deadlines.tasks).
_ACCEPTANCE_OUTCOME_ACCEPTED = "accepted"
_ACCEPTANCE_OUTCOME_REJECTED = "rejected"
_SUSPENSION_DEADLINE_KIND = "milestone_material_notice"


class StructureNotEditableError(ValueError):
    """Договор больше не в draft/under_review — редактирование структуры
    этапов доступно только через допник (Э4.5, tech-spec.md §8.5:
    `409 contract_immutable`)."""


class MilestoneWrongContractError(ValueError):
    """`parent_id` указывает на этап другого договора."""


class MilestoneDepthExceededError(ValueError):
    """Глубина дерева превысила MAX_TREE_DEPTH (tech-spec.md §5.2.5)."""


class MilestoneAmountGuardError(ValueError):
    """Тот же инвариант, что БД-триггер `milestone_amount_guard`
    (миграция 0002): amount у ветки (есть дети) или ребёнок у листа
    (amount уже задан) — здесь проверяется до записи ради читаемой
    422-ошибки, триггер — последний рубеж защиты."""


class MilestoneHasLeafContentError(ValueError):
    """Нельзя добавить ребёнка узлу, у которого уже есть чек-лист/материалы
    — они привязываются только к ЛИСТУ (domain-model.md §7.2/§7.3)."""


class MilestoneNotLeafError(ValueError):
    """ChecklistItem/ContractMaterial создаются только на ЛИСТЕ."""


class MaterialCatalogItemNotFoundError(LookupError):
    """`catalog_item_code` не резолвится в активную позицию каталога
    материалов (минимум «Прочее» сферы должно существовать)."""


class SphereNotFoundError(LookupError):
    """`sphere_code` не резолвится в apps.catalog.Sphere."""


class MoneyPairRequiredError(ValueError):
    """`amount`/`currency` — только вместе (CLAUDE.md: валюты по умолчанию
    нет нигде) — частичный ввод запрещён."""


class CurrencyNotActiveError(ValueError):
    """Валюта не входит в активный справочник apps.catalog.Currency
    (CLAUDE.md: валюты по умолчанию нет нигде — код всегда явный)."""


class MaterialPriceRequiredError(ValueError):
    """Правило цены ADR-047 (tech-spec.md §5.2.5): `unit_price=0` допустим
    ТОЛЬКО при `source=customer` — исполнитель не поставляет материал по
    нулевой цене."""


class LeafSumMismatchError(ValueError):
    """Сумма листьев не равна ожидаемой сумме договора — сервис проверки
    для Э4.4 (заморозка сама валидацию не запускает в этой ветке)."""


class LoanScheduleNotApplicableError(ValueError):
    """Материализация графика в этапы-листья доступна только для
    `loan_individuals` с `repayment_type=schedule` в form_data (П-16,
    docs/tasks/etap-4-delta-p16.md §6)."""


class MilestoneNotFoundError(LookupError):
    """`apply_amendment_milestone_*` (Э4.5): `target` не резолвится в
    существующий Milestone — защитный рубеж, цель уже проверена на
    создании допника (`apps.contracts.services._create_amendment_change`),
    сюда попадает только при рассинхроне между созданием и применением."""


class ContractMaterialNotFoundError(LookupError):
    """`apply_amendment_material_*` (Э4.5) — тот же защитный рубеж, что
    `MilestoneNotFoundError`, для `ContractMaterial`."""


class MilestoneDependsOnInvalidError(ValueError):
    """`depends_on` (предшественник этапа — «условие старта» в терминах
    карточки, ADR-157) указывает на этап ЧУЖОГО договора, на сам этап или
    замыкает цепочку предшественников в кольцо. До ADR-157 связь ставилась
    только на создании (`create_milestone`), где эти случаи не возникали;
    правка через протокол разногласий даёт задать её любым значением,
    поэтому проверка нужна явная."""


class _Unset:
    """Часовой «поле не передано» — для полей, у которых `None` само по себе
    ЗНАЧЕНИЕ. У `patch_milestone`/`patch_material` конвенция «`None` — не
    менять», но `depends_on=None` значит «снять условие старта» (ADR-157), и
    отличить одно от другого без часового нельзя."""

    __slots__ = ()

    def __repr__(self) -> str:  # pragma: no cover — только для отладки
        return "UNSET"


UNSET = _Unset()


def _assert_editable(contract: Contract) -> None:
    if contract.negotiation_status not in _EDITABLE_NEGOTIATION_STATUSES:
        raise StructureNotEditableError(
            f"договор {contract.id} в статусе {contract.negotiation_status!r} — "
            "структура этапов редактируется только до подписания"
        )


def _assert_valid_predecessor(milestone: Milestone, depends_on: Milestone | None) -> None:
    """`depends_on` — этап ТОГО ЖЕ договора, не сам этап и не звено цепочки,
    которая ведёт обратно в него (ADR-157). Кольцо ищется обходом вверх по
    `depends_on`, а не рекурсивным CTE: цепочка ограничена числом этапов
    договора, а их немного (та же логика, что у `selectors.children_map`)."""
    if depends_on is None:
        return
    if depends_on.contract_id != milestone.contract_id:
        raise MilestoneDependsOnInvalidError(f"этап {depends_on.id} принадлежит другому договору")
    if depends_on.id == milestone.id:
        raise MilestoneDependsOnInvalidError("этап не может зависеть от самого себя")
    seen = {milestone.id}
    node: Milestone | None = depends_on
    while node is not None:
        if node.id in seen:
            raise MilestoneDependsOnInvalidError(
                f"цепочка предшественников замыкается на этапе {milestone.id}"
            )
        seen.add(node.id)
        node = node.depends_on


def _assert_currency_active(currency_code: str) -> None:
    if not Currency.objects.filter(code=currency_code, is_active=True).exists():
        raise CurrencyNotActiveError(f"валюта {currency_code!r} не активна в справочнике")


def _resolve_sphere(sphere_code: str | None) -> Sphere | None:
    if sphere_code is None:
        return None
    try:
        # is_active=True — тот же приём, что _assert_currency_active:
        # деактивированная сфера (chore/sphere-dedup, apps.catalog.
        # migrations.0015_deactivate_or_delete_tutoring_sphere — fallback,
        # когда удалить строку не даёт защищённый FK) не выбирается заново
        # для НОВЫХ милстоунов; уже существующие Milestone.sphere на неё —
        # не трогаются (PROTECT), это только гейт на запись.
        return Sphere.objects.get(code=sphere_code, is_active=True)
    except Sphere.DoesNotExist as exc:
        raise SphereNotFoundError(f"сфера {sphere_code!r} не найдена") from exc


def _build_money(amount: Decimal | str | None, currency: str | None) -> Money | None:
    """amount/currency — всегда пара (CLAUDE.md): либо оба заданы, либо ни
    одного. Частичный ввод — явная 422-ошибка, а не TypeError из
    Decimal(None) внутри common.money.Money."""
    if (amount is None) != (currency is None):
        raise MoneyPairRequiredError(
            "amount и currency нужно указывать вместе (или не указывать оба)"
        )
    if amount is None or currency is None:
        return None
    return Money(amount, currency)


def _create_milestone(
    contract: Contract,
    *,
    title: str,
    parent: Milestone | None,
    order: int,
    amount: Decimal | str | None,
    currency: str | None,
    sphere_code: str | None,
    deadline: datetime | None,
    depends_on: Milestone | None,
    created_by_amendment: Amendment | None = None,
) -> Milestone:
    """Ядро создания этапа — валидация родителя/глубины/суммы, БЕЗ проверки
    прав пользователя и БЕЗ гейта `_assert_editable` (тот, кому он нужен,
    накладывает его сам — см. `create_milestone` и
    `apply_amendment_milestone_add`, Э4.5)."""
    if parent is not None:
        if parent.contract_id != contract.id:
            raise MilestoneWrongContractError(
                f"этап {parent.id} принадлежит другому договору, не {contract.id}"
            )
        if selectors.level(parent) + 1 > MAX_TREE_DEPTH:
            raise MilestoneDepthExceededError(
                f"глубина дерева не может превышать {MAX_TREE_DEPTH} уровней"
            )
        if parent.amount is not None:
            raise MilestoneAmountGuardError(
                f"этап {parent.id} — лист (amount задан), нельзя добавить ребёнка"
            )
        if parent.checklist_items.exists() or parent.materials.exists():
            raise MilestoneHasLeafContentError(
                f"у этапа {parent.id} уже есть чек-лист/материалы — он лист, не ветка"
            )

    money = _build_money(amount, currency)
    if money is not None:
        _assert_currency_active(money.currency)

    return Milestone.objects.create(
        contract=contract,
        parent=parent,
        order=order,
        title=title,
        amount=money.amount if money else None,
        amount_currency=money.currency if money else None,
        sphere=_resolve_sphere(sphere_code),
        deadline=deadline,
        depends_on=depends_on,
        created_by_amendment=created_by_amendment,
    )


@transaction.atomic
def create_milestone(
    contract: Contract,
    *,
    user: User,
    title: str,
    parent: Milestone | None = None,
    order: int = 0,
    amount: Decimal | str | None = None,
    currency: str | None = None,
    sphere_code: str | None = None,
    deadline: datetime | None = None,
    depends_on: Milestone | None = None,
) -> Milestone:
    """POST /contracts/{id}/milestones (tech-spec.md §8.5)."""
    contracts_services.get_party_for_user(contract, user)
    _assert_editable(contract)
    milestone = _create_milestone(
        contract,
        title=title,
        parent=parent,
        order=order,
        amount=amount,
        currency=currency,
        sphere_code=sphere_code,
        deadline=deadline,
        depends_on=depends_on,
    )
    outbox.publish(
        "milestone.created",
        subject={"type": "milestone", "id": str(milestone.id), "contract_id": str(contract.id)},
        payload={"parent_id": str(parent.id) if parent else None, "title": title},
        actor={"user_id": str(user.id)},
    )
    return milestone


@transaction.atomic
def patch_milestone(
    milestone: Milestone,
    *,
    user: User,
    title: str | None = None,
    order: int | None = None,
    amount: Decimal | str | None = None,
    currency: str | None = None,
    sphere_code: str | None = None,
    deadline: datetime | None = None,
    depends_on: Milestone | None | _Unset = UNSET,
) -> Milestone:
    """PATCH /milestones/{id} (tech-spec.md §8.5). `None` — «не менять»
    (тот же приём, что apps.contracts.services.patch_draft): очистка уже
    заданного amount через PATCH не поддерживается этой веткой.

    Исключение — `depends_on` (предшественник, «условие старта» в карточке):
    у него `None` — законное ЗНАЧЕНИЕ «условия нет», поэтому «не менять»
    несёт часовой `UNSET` (ADR-157). Проверки — `_assert_same_contract_
    predecessor`: чужой договор / сам на себя / кольцо."""
    contract = milestone.contract
    contracts_services.get_party_for_user(contract, user)
    _assert_editable(contract)

    update_fields: list[str] = []
    if title is not None:
        milestone.title = title
        update_fields.append("title")
    if not isinstance(depends_on, _Unset):
        _assert_valid_predecessor(milestone, depends_on)
        milestone.depends_on = depends_on
        update_fields.append("depends_on")
    if order is not None:
        milestone.order = order
        update_fields.append("order")
    if sphere_code is not None:
        milestone.sphere = _resolve_sphere(sphere_code)
        update_fields.append("sphere")
    if deadline is not None:
        milestone.deadline = deadline
        update_fields.append("deadline")
    if amount is not None or currency is not None:
        if milestone.children.exists():
            raise MilestoneAmountGuardError(
                f"этап {milestone.id} — ветка (есть дети), amount запрещён"
            )
        money = _build_money(amount, currency)
        assert money is not None  # amount/currency: хотя бы один задан -> оба (см. _build_money)
        _assert_currency_active(money.currency)
        milestone.amount = money.amount
        milestone.amount_currency = money.currency
        update_fields += ["amount", "amount_currency"]

    if update_fields:
        milestone.save(update_fields=update_fields)
        outbox.publish(
            "milestone.updated",
            subject={
                "type": "milestone",
                "id": str(milestone.id),
                "contract_id": str(contract.id),
            },
            payload={"fields": update_fields},
            actor={"user_id": str(user.id)},
        )
    return milestone


@transaction.atomic
def delete_milestone(milestone: Milestone, *, user: User) -> None:
    """DELETE /milestones/{id} (ADR-101): удаление этапа из дерева ДО
    подписания — та же зона редактируемости, что у `create_milestone`/
    `patch_milestone` (`_assert_editable`: draft/under_review). Поддерево
    (дети, чек-листы, материалы) уходит каскадом по FK. После заморозки
    версии — 409 `contract_immutable`, изменения только через Amendment
    (`apply_amendment_milestone_remove`). Мягкого удаления нет: до подписания
    этап не юрзначим, снепшотов на него ещё нет."""
    contract = milestone.contract
    contracts_services.get_party_for_user(contract, user)
    _assert_editable(contract)
    milestone_id = str(milestone.id)
    parent_id = str(milestone.parent_id) if milestone.parent_id else None
    milestone.delete()
    outbox.publish(
        "milestone.deleted",
        subject={"type": "milestone", "id": milestone_id, "contract_id": str(contract.id)},
        payload={"parent_id": parent_id},
        actor={"user_id": str(user.id)},
    )


@transaction.atomic
def create_checklist_item(
    milestone: Milestone,
    *,
    user: User,
    description: str,
    measurable_criterion: str,
    required_evidence: list[str],
    order: int = 0,
) -> ChecklistItem:
    """POST /milestones/{id}/checklist-items (tech-spec.md §8.5).

    Если формулировка пришла из подсказки каталога (`GET
    /checklist-recommendations`), пункт запоминает свой шаблон
    (`source_template`) и двигает его счётчик востребованности — из него
    строится порядок подсказок в мастере (ADR-153). Сопоставление и сам
    счётчик живут в apps.catalog за фасадом `record_checklist_pick`: каталог
    — нижний слой и читать чек-листы этапов не может, поэтому знание едет
    к нему, а не он за ним. Свой текст ни с чем не совпадёт — фасад вернёт
    `None`, счётчик не двинется. Всё в одной транзакции с созданием пункта:
    откат создания откатывает и пик."""
    contract = milestone.contract
    contracts_services.get_party_for_user(contract, user)
    _assert_editable(contract)
    if milestone.children.exists():
        raise MilestoneNotLeafError(f"этап {milestone.id} — ветка, чек-лист только на листе")

    source_template = catalog_services.record_checklist_pick(
        description=description, sphere_id=selectors.effective_sphere_id(milestone)
    )
    item = ChecklistItem.objects.create(
        milestone=milestone,
        source_template=source_template,
        description=description,
        measurable_criterion=measurable_criterion,
        required_evidence=required_evidence,
        order=order,
    )
    outbox.publish(
        "milestone.checklist_item_added",
        subject={"type": "milestone", "id": str(milestone.id), "contract_id": str(contract.id)},
        payload={"checklist_item_id": str(item.id)},
        actor={"user_id": str(user.id)},
    )
    return item


@transaction.atomic
def patch_checklist_item(
    item: ChecklistItem,
    *,
    user: User,
    description: str | None = None,
    measurable_criterion: str | None = None,
    required_evidence: list[str] | None = None,
    order: int | None = None,
) -> ChecklistItem:
    """PATCH /checklist-items/{id} — правка пункта чек-листа ДО подписания
    (та же зона редактируемости, что у `create_checklist_item`:
    `_assert_editable` — draft/under_review, иначе 409 `contract_immutable`).
    `None` — «не менять» (приём `patch_milestone`). Нужен мастеру создания:
    после сохранения этапа критерии приёмки продолжают редактироваться
    (отсмотр 2026-08-25 — «после одного критерия другие не сохранялись»)."""
    milestone = item.milestone
    contract = milestone.contract
    contracts_services.get_party_for_user(contract, user)
    _assert_editable(contract)

    update_fields: list[str] = []
    if description is not None:
        item.description = description
        update_fields.append("description")
    if measurable_criterion is not None:
        item.measurable_criterion = measurable_criterion
        update_fields.append("measurable_criterion")
    if required_evidence is not None:
        item.required_evidence = required_evidence
        update_fields.append("required_evidence")
    if order is not None:
        item.order = order
        update_fields.append("order")

    if update_fields:
        item.save(update_fields=update_fields)
        outbox.publish(
            "milestone.checklist_item_updated",
            subject={
                "type": "milestone",
                "id": str(milestone.id),
                "contract_id": str(contract.id),
            },
            payload={"checklist_item_id": str(item.id), "fields": update_fields},
            actor={"user_id": str(user.id)},
        )
    return item


@transaction.atomic
def delete_checklist_item(item: ChecklistItem, *, user: User) -> None:
    """DELETE /checklist-items/{id} — удаление пункта чек-листа ДО подписания
    (`_assert_editable`, как у `create_checklist_item`/`delete_milestone`).
    После заморозки версии — 409 `contract_immutable`. Мягкого удаления нет:
    до подписания пункт не юрзначим, снепшотов на него ещё нет."""
    milestone = item.milestone
    contract = milestone.contract
    contracts_services.get_party_for_user(contract, user)
    _assert_editable(contract)
    item_id = str(item.id)
    item.delete()
    outbox.publish(
        "milestone.checklist_item_removed",
        subject={"type": "milestone", "id": str(milestone.id), "contract_id": str(contract.id)},
        payload={"checklist_item_id": item_id},
        actor={"user_id": str(user.id)},
    )


def _resolve_material_catalog_item(code: str | None) -> MaterialCatalogItem | None:
    """Позиция каталога по коду. `None` на входе — «не менять» (PATCH), на
    выходе тоже `None`; ненайденный/неактивный код — 404
    `MaterialCatalogItemNotFoundError`. Общий резолв для создания и правки:
    два одинаковых `objects.get(..., is_active=True)` разошлись бы при
    первой же смене правил каталога."""
    if code is None:
        return None
    try:
        return MaterialCatalogItem.objects.get(code=code, is_active=True)
    except MaterialCatalogItem.DoesNotExist as exc:
        raise MaterialCatalogItemNotFoundError(f"позиция каталога {code!r} не найдена") from exc


def _create_material(
    milestone: Milestone,
    *,
    catalog_item_code: str,
    description: str,
    source: str,
    unit_price: Decimal | str,
    unit_price_currency: str,
    external_url: str = "",
    quantity: Decimal | str = Decimal("0"),
    unit: str = "",
    delivery_days: int = 0,
    delivery_base: str = ContractMaterial.DeliveryBase.CONTRACT_SIGNING,
) -> ContractMaterial:
    """Ядро создания материала — каталог + правило цены ADR-047, БЕЗ проверки
    прав пользователя, БЕЗ гейта `_assert_editable` и БЕЗ проверки «только
    лист» (у `apply_amendment_material_add`, Э4.5, лист уже проверен на
    создании допника — см. `apps.contracts.services._create_amendment_change`)."""
    catalog_item = _resolve_material_catalog_item(catalog_item_code)
    assert catalog_item is not None  # на создании код обязателен, mypy этого не выводит

    price = Money(unit_price, unit_price_currency)
    _assert_currency_active(price.currency)
    if source == _SOURCE.CONTRACTOR and price.amount <= 0:
        raise MaterialPriceRequiredError(
            "исполнитель не может поставлять материал по нулевой цене (ADR-047)"
        )

    return ContractMaterial.objects.create(
        milestone=milestone,
        catalog_item=catalog_item,
        description=description,
        external_url=external_url,
        quantity=Decimal(str(quantity)),
        unit=unit,
        unit_price=price.amount,
        unit_price_currency=price.currency,
        source=source,
        delivery_days=delivery_days,
        delivery_base=delivery_base,
    )


@transaction.atomic
def create_material(
    milestone: Milestone,
    *,
    user: User,
    catalog_item_code: str,
    description: str,
    source: str,
    unit_price: Decimal | str,
    unit_price_currency: str,
    external_url: str = "",
    quantity: Decimal | str = Decimal("0"),
    unit: str = "",
    delivery_days: int = 0,
    delivery_base: str = ContractMaterial.DeliveryBase.CONTRACT_SIGNING,
) -> ContractMaterial:
    """POST /milestones/{id}/materials (tech-spec.md §8.5): catalog_item
    обязателен (минимум «Прочее» сферы), описание обязательно, правило
    цены ADR-047."""
    contract = milestone.contract
    contracts_services.get_party_for_user(contract, user)
    _assert_editable(contract)
    if milestone.children.exists():
        raise MilestoneNotLeafError(f"этап {milestone.id} — ветка, материалы только на листе")

    material = _create_material(
        milestone,
        catalog_item_code=catalog_item_code,
        description=description,
        source=source,
        unit_price=unit_price,
        unit_price_currency=unit_price_currency,
        external_url=external_url,
        quantity=quantity,
        unit=unit,
        delivery_days=delivery_days,
        delivery_base=delivery_base,
    )
    outbox.publish(
        "milestone.material_added",
        subject={"type": "milestone", "id": str(milestone.id), "contract_id": str(contract.id)},
        # ADR-156: `milestone_title` в payload — событие самодостаточно.
        # По нему подписчик уведомлений строит текст карточки, а хроника
        # этапа — подпись (`ui.timeline.milestone.material_added.detail`),
        # не ходя за названием в БД.
        payload={
            "material_id": str(material.id),
            "catalog_item_code": catalog_item_code,
            "milestone_title": milestone.title,
        },
        actor={"user_id": str(user.id)},
    )
    return material


@transaction.atomic
def patch_material(
    material: ContractMaterial,
    *,
    user: User,
    catalog_item_code: str | None = None,
    description: str | None = None,
    external_url: str | None = None,
    quantity: Decimal | str | None = None,
    unit: str | None = None,
    unit_price: Decimal | str | None = None,
    unit_price_currency: str | None = None,
    source: str | None = None,
    delivery_days: int | None = None,
    delivery_base: str | None = None,
) -> ContractMaterial:
    """PATCH /materials/{id} — правка материала ДО подписания (та же зона
    редактируемости, что у `create_material`: `_assert_editable` —
    draft/under_review, иначе 409 `contract_immutable`). Замечание владельца
    03.09: «если договор редактируется, должна быть возможность
    редактировать и материалы» — до ADR-155 материал можно было только
    создать, правка требовала удалить-и-создать заново, чего эндпоинта тоже
    не было. `None` — «не менять» (приём `patch_checklist_item`).

    Поля — те же, что у POST, включая `catalog_item_code` (тот же резолв по
    коду активной позиции, что в `_create_material`): фронт
    (`feat/web-wizard-materials`) в режиме правки даёт сменить наименование
    из каталога и присылает diff ВСЕХ полей позиции. Запрещать смену
    позиции значило бы превращать правку в «удалить и завести заново» — а
    это теряет `handed_over_*`/`received*` и историю строки. Цена/источник
    проверяются правилом ADR-047 тем же кодом, что при создании."""
    milestone = material.milestone
    contract = milestone.contract
    contracts_services.get_party_for_user(contract, user)
    _assert_editable(contract)

    catalog_item = _resolve_material_catalog_item(catalog_item_code)
    new_source = source if source is not None else material.source
    price = Money(
        unit_price if unit_price is not None else material.unit_price,
        unit_price_currency if unit_price_currency is not None else material.unit_price_currency,
    )
    if unit_price is not None or unit_price_currency is not None:
        _assert_currency_active(price.currency)
    if new_source == _SOURCE.CONTRACTOR and price.amount <= 0:
        raise MaterialPriceRequiredError(
            "исполнитель не может поставлять материал по нулевой цене (ADR-047)"
        )

    update_fields: list[str] = []
    simple: dict[str, Any] = {
        "description": description,
        "external_url": external_url,
        "unit": unit,
        "delivery_days": delivery_days,
        "delivery_base": delivery_base,
    }
    for field, value in simple.items():
        if value is not None:
            setattr(material, field, value)
            update_fields.append(field)
    if quantity is not None:
        material.quantity = Decimal(str(quantity))
        update_fields.append("quantity")
    if unit_price is not None or unit_price_currency is not None:
        material.unit_price = price.amount
        material.unit_price_currency = price.currency
        update_fields.extend(["unit_price", "unit_price_currency"])
    if source is not None:
        material.source = source
        update_fields.append("source")
    if catalog_item is not None:
        material.catalog_item = catalog_item
        update_fields.append("catalog_item")

    if update_fields:
        material.save(update_fields=update_fields)
        outbox.publish(
            "milestone.material_updated",
            subject={
                "type": "milestone",
                "id": str(milestone.id),
                "contract_id": str(contract.id),
            },
            payload={
                "material_id": str(material.id),
                "fields": update_fields,
                "milestone_title": milestone.title,
            },
            actor={"user_id": str(user.id)},
        )
    return material


@transaction.atomic
def delete_material(material: ContractMaterial, *, user: User) -> None:
    """DELETE /materials/{id} — удаление материала ДО подписания
    (`_assert_editable`, как у `delete_checklist_item`). После заморозки
    версии — 409 `contract_immutable`; мягкого удаления нет: до подписания
    материал не юрзначим."""
    milestone = material.milestone
    contract = milestone.contract
    contracts_services.get_party_for_user(contract, user)
    _assert_editable(contract)
    material_id = str(material.id)
    material.delete()
    outbox.publish(
        "milestone.material_removed",
        subject={"type": "milestone", "id": str(milestone.id), "contract_id": str(contract.id)},
        payload={"material_id": material_id, "milestone_title": milestone.title},
        actor={"user_id": str(user.id)},
    )


def recommend_checklist_items(milestone: Milestone) -> list[dict[str, Any]]:
    """GET /milestones/{id}/checklist-recommendations (tech-spec.md §8.5,
    ADR-047): рекомендации по материалам листа + базовые пункты его
    эффективной сферы. Справочник ТОЛЬКО подсказывает — ничего не
    создаёт (apply — отдельный POST .../checklist-items вызывающей
    стороной с полями из рекомендации, один клик на фронтенде)."""
    catalog_item_ids = list(
        milestone.materials.values_list("catalog_item_id", flat=True).distinct()
    )
    sphere_id = selectors.effective_sphere_id(milestone)
    templates = catalog_selectors.recommended_checklist_template_items(
        catalog_item_ids=catalog_item_ids, sphere_id=sphere_id
    )
    return [
        {
            "source_template_id": str(t.id),
            "description": t.description,
            "measurable_criterion": t.measurable_criterion,
            "required_evidence": list(t.required_evidence),
        }
        for t in templates
    ]


def total_leaf_amount(contract: Contract) -> Money:
    """Сумма всех листьев договора (по всем корневым этапам — их может
    быть несколько, например график займа как N этапов-листьев без общей
    ветки). Сервис проверки для Э4.4 (`assert_leaf_sum_matches`) —
    здесь валидация НЕ вызывается на каком-либо переходе."""
    cmap = selectors.children_map(contract)
    roots = cmap.get(None, [])
    if not roots:
        raise ValueError(f"у договора {contract.id} нет ни одного этапа")
    amounts = [selectors.computed_amount(r, children_map=cmap) for r in roots]
    currency = assert_single_currency(amounts)
    total = sum((a.amount for a in amounts), start=Decimal("0"))
    return Money(total, currency)


def assert_leaf_sum_matches(contract: Contract, expected_total: Money) -> None:
    """«Сумма листьев = сумма договора» (tech-spec.md §6.1) — сама
    валидация запускается на заморозке (Э4.4), здесь только сервис
    проверки (etap-4.md Э4.3)."""
    total = total_leaf_amount(contract)
    if total != expected_total:
        raise LeafSumMismatchError(
            f"сумма листьев {total} не равна ожидаемой сумме договора {expected_total}"
        )


@transaction.atomic
def materialize_loan_schedule(contract: Contract, *, user: User, currency: str) -> list[Milestone]:
    """Для «Займа» график возврата — этапы-листья (etap-4.md Э4.3
    приёмка): читает `form_data.schedule` (П-16, repayment_type=schedule —
    список {due_date, amount}, уже провалидированный apps.contracts.forms
    при сохранении черновика) и материализует каждый платёж как корневой
    этап-лист. `currency` — явный параметр вызывающего (ADR-041: валюта
    юрисдикции — только подстановка в UI, не дефолт в бизнес-логике)."""
    if contract.contract_type_id != "loan_individuals":
        raise LoanScheduleNotApplicableError(
            f"договор {contract.id} не «Займ» ({contract.contract_type_id!r})"
        )
    if contract.form_data.get("repayment_type") != "schedule":
        raise LoanScheduleNotApplicableError(
            "form_data.repayment_type должен быть 'schedule' (не lump_sum)"
        )
    schedule = contract.form_data.get("schedule") or []
    if not schedule:
        raise LoanScheduleNotApplicableError("form_data.schedule пуст")

    created: list[Milestone] = []
    for index, item in enumerate(schedule):
        try:
            due = date.fromisoformat(str(item["due_date"]))
            payment_amount = Decimal(str(item["amount"]))
        except (KeyError, InvalidOperation, ValueError) as exc:
            raise LoanScheduleNotApplicableError(
                f"элемент графика {index} некорректен: {item!r}"
            ) from exc
        milestone = create_milestone(
            contract,
            user=user,
            title=f"Платёж {index + 1} — {due.isoformat()}",
            order=index,
            amount=payment_amount,
            currency=currency,
            deadline=datetime.combine(due, time.min, tzinfo=UTC),
        )
        created.append(milestone)
    return created


# --- Э4.5: применение допника -------------------------------------------
#
# Вызываются ИСКЛЮЧИТЕЛЬНО из apps.contracts.services.apply_amendment на
# второй подписи допника (contract.negotiation_status уже signed) — без
# гейта _assert_editable (см. докстринг модуля) и без повторной валидации
# гейтов «принят»/«получен»: их уже проверила apps.contracts.services.
# _create_amendment_change ПРИ СОЗДАНИИ допника (422 на создании, не на
# применении — приёмка etap-4.md Э4.5). payload — сырой JSON (JSONField),
# даты приходят строками, парсим явно (тот же приём, что
# materialize_loan_schedule выше).


def apply_amendment_milestone_add(
    contract: Contract, *, amendment: Amendment, payload: dict[str, Any]
) -> Milestone:
    """`add_milestone`: `created_by_amendment=amendment` — происхождение
    этапа видно (etap-4.md Э4.5, приёмка)."""
    parent_id = payload.get("parent_id")
    parent = Milestone.objects.get(pk=parent_id, contract=contract) if parent_id else None
    deadline_raw = payload.get("deadline")
    milestone = _create_milestone(
        contract,
        title=payload["title"],
        parent=parent,
        order=payload.get("order", 0),
        amount=payload.get("amount"),
        currency=payload.get("currency"),
        sphere_code=payload.get("sphere_code"),
        deadline=datetime.fromisoformat(deadline_raw) if deadline_raw else None,
        depends_on=None,
        created_by_amendment=amendment,
    )
    outbox.publish(
        "milestone.created",
        subject={"type": "milestone", "id": str(milestone.id), "contract_id": str(contract.id)},
        payload={
            "parent_id": str(parent.id) if parent else None,
            "title": milestone.title,
            "created_by_amendment": str(amendment.id),
        },
        actor={},
    )
    return milestone


def _get_amendment_milestone(target: UUID) -> Milestone:
    try:
        return Milestone.objects.get(pk=target)
    except Milestone.DoesNotExist as exc:
        raise MilestoneNotFoundError(f"этап {target} не найден") from exc


def apply_amendment_milestone_remove(*, target: UUID) -> None:
    """`remove_milestone` — «лист, не принят» уже проверено на создании
    допника (`_create_amendment_change`)."""
    _get_amendment_milestone(target).delete()


def apply_amendment_milestone_modify(*, target: UUID, payload: dict[str, Any]) -> Milestone:
    """`modify_milestone` — «не удешевляет принятое» уже проверено на
    создании допника."""
    milestone = _get_amendment_milestone(target)
    update_fields: list[str] = []
    if "title" in payload:
        milestone.title = payload["title"]
        update_fields.append("title")
    if "amount" in payload and "currency" in payload:
        milestone.amount = Decimal(str(payload["amount"]))
        milestone.amount_currency = payload["currency"]
        update_fields += ["amount", "amount_currency"]
    if "deadline" in payload:
        milestone.deadline = datetime.fromisoformat(payload["deadline"])
        update_fields.append("deadline")
    if "sphere_code" in payload:
        milestone.sphere = _resolve_sphere(payload["sphere_code"])
        update_fields.append("sphere")
    if update_fields:
        milestone.save(update_fields=update_fields)
    return milestone


def apply_amendment_material_add(
    *, milestone_id: UUID, payload: dict[str, Any]
) -> ContractMaterial:
    """`add_material` — «лист» уже проверен на создании допника."""
    milestone = _get_amendment_milestone(milestone_id)
    return _create_material(
        milestone,
        catalog_item_code=payload["catalog_item_code"],
        description=payload["description"],
        source=payload["source"],
        unit_price=payload["unit_price"],
        unit_price_currency=payload["unit_price_currency"],
        external_url=payload.get("external_url", ""),
        quantity=payload.get("quantity", Decimal("0")),
        unit=payload.get("unit", ""),
        delivery_days=payload.get("delivery_days", 0),
        delivery_base=payload.get("delivery_base", ContractMaterial.DeliveryBase.CONTRACT_SIGNING),
    )


def _get_amendment_material(target: UUID) -> ContractMaterial:
    try:
        return ContractMaterial.objects.get(pk=target)
    except ContractMaterial.DoesNotExist as exc:
        raise ContractMaterialNotFoundError(f"материал {target} не найден") from exc


def apply_amendment_material_modify(*, target: UUID, payload: dict[str, Any]) -> ContractMaterial:
    material = _get_amendment_material(target)
    update_fields: list[str] = []
    for field in ("description", "external_url", "unit", "delivery_days", "delivery_base"):
        if field in payload:
            setattr(material, field, payload[field])
            update_fields.append(field)
    if "quantity" in payload:
        material.quantity = Decimal(str(payload["quantity"]))
        update_fields.append("quantity")
    if "unit_price" in payload and "unit_price_currency" in payload:
        material.unit_price = Decimal(str(payload["unit_price"]))
        material.unit_price_currency = payload["unit_price_currency"]
        update_fields += ["unit_price", "unit_price_currency"]
    if update_fields:
        material.save(update_fields=update_fields)
    return material


def apply_amendment_material_remove(*, target: UUID) -> None:
    """`remove_material` — «не получен» уже проверено на создании допника."""
    _get_amendment_material(target).delete()


# --- Э4.6: исполнение — гейт, сдача, приёмка (docs/tasks/etap-4.md) --------


class GateNotOnLeafError(ValueError):
    """Гейт/сдача/приёмка — операции ЛИСТА (domain-model.md §7.1
    `can_start`: `assert self.is_leaf()`). Ветки не проходят гейт — их
    статус вычислялся бы из листьев, если бы кому-то понадобился (эта ветка
    его не считает — не запрошено)."""


class GateNotSignedError(ValueError):
    """Гейт листа: договор должен быть `signed` (tech-spec.md §6.3)."""


class GateMaterialsNotReadyError(ValueError):
    """Гейт листа: есть материал `source=customer` с `received=False` —
    заказчик ещё не передал материалы, нужные для старта (domain-model.md
    §7.3 `notify_material_problem` — симметрично ADR-019)."""


class GateFinancialConditionNotMetError(ValueError):
    """Гейт листа: финансовое условие по способу расчёта не выполнено
    (tech-spec.md §6.3 `financial_condition_met`). `reason` — машиночитаемый
    код для api/: `payment_not_confirmed` (ADR-155, `payment_order=
    before_start` — оплату листа подтвердили не обе стороны),
    `awaiting_payment` (direct_platform/hold — ЧЕСТНАЯ заглушка, партнёра
    нет), `payment_method_not_set`."""

    def __init__(self, message: str, *, reason: str) -> None:
        super().__init__(message)
        self.reason = reason


class MaterialProblemNotOnCustomerSourceError(ValueError):
    """`POST /materials/{id}/problem-notice` — жалоба на материал ЗАКАЗЧИКА
    (domain-model.md §7.3 `notify_material_problem`); для `source=contractor`
    бессмысленна — материал поставляет сам жалующийся."""


# ADR-164: `RequiredEvidenceNotCoveredError` (422
# `required_evidence_not_covered`) УПРАЗДНЁН вместе с гейтом сдачи —
# непокрытые `required_evidence` больше не запрет, а подсказка
# (`selectors.uncovered_required_evidence`). Класс удалён, а не оставлен
# «на всякий случай»: живого пути его поднять нет, а мёртвое исключение в
# карте ошибок views.py читалось бы как действующее правило.


class ChecklistItemRequiredError(ValueError):
    """`POST /milestones/{id}/reject` без `checklist_item_id` (ADR-017,
    tech-spec.md §8.5: `422 checklist_item_required`) — «нет пункта -> нечего
    оспаривать -> работа принята»."""


class ChecklistItemNotOnMilestoneError(ValueError):
    """`checklist_item_id` в `reject` указывает на пункт ДРУГОГО этапа."""


class EvidenceRequiredError(ValueError):
    """`POST /milestones/{id}/reject` без `evidence` — симметрично
    `ChecklistItemRequiredError` (ADR-017: доказательство обязательно)."""


class WrongConfirmationSideError(ValueError):
    """`side` в подтверждении (аванс/оплата-заглушка) не совпадает с ролью
    вызывающего в договоре — нельзя подтвердить «за контрагента»."""


class MaterialHandoverWrongSideError(ValueError):
    """ADR-155: «передал» отмечает ТОЛЬКО сторона-источник (`source`),
    «получил» — ТОЛЬКО другая сторона. Порядок между шагами не обязателен
    (владелец 03.09: получение можно отметить односторонне), но подтвердить
    получение ЗА СЕБЯ нельзя — иначе гейт этапа открывал бы сам поставщик
    материалов (та же логика, что `WrongConfirmationSideError` в деньгах)."""


def _assert_leaf(milestone: Milestone) -> None:
    if milestone.children.exists():
        raise GateNotOnLeafError(f"этап {milestone.id} — ветка, не лист")


# `_party_user`/`_counterparty` перенесены в apps.contracts.selectors
# (party_user/resolve_counterparty) — Э4.6 объявляла их частным приёмом
# apps.milestones, ГВ.3 понадобился тот же приём в apps.evidence, дублировать
# логику резолва стороны/контрагента во втором приложении не стали
# (см. докстринг apps.contracts.selectors.party_user).


def _event_payload(milestone: Milestone, **extra: Any) -> dict[str, Any]:
    """Самодостаточный payload («доп. требование, док 31 §7»: событие несёт
    договор/этап/обе стороны/метку времени — репутационная карточка ГВ.4
    строит её ИСКЛЮЧИТЕЛЬНО из событий outbox, «не записанное сейчас не
    восстановится»). `milestone_sphere_code` — добавлено для ГВ.4 (без
    него read-модель карточки не знала бы сферу сделки, не читая
    apps.milestones напрямую — «сфера» есть только на листе дерева
    этапов, tech-spec.md §5.2.5, а не на Contract)."""
    sphere = milestone.sphere
    payload: dict[str, Any] = {
        "contract_id": str(milestone.contract_id),
        "milestone_id": str(milestone.id),
        "milestone_title": milestone.title,
        "milestone_sphere_code": sphere.code if sphere is not None else None,
        # ADR-163 §6 (ось исполнителя «сделано в срок»): дедлайн этапа и
        # момент сдачи — тот же аддитивный приём, что `milestone_sphere_code`
        # выше. `due_at=None` — у этапа дедлайна нет: read-модель не считает
        # такой этап просроченным, она вообще не берёт его в знаменатель.
        "due_at": milestone.deadline.isoformat() if milestone.deadline else None,
        "submitted_at": milestone.submitted_at.isoformat() if milestone.submitted_at else None,
        "parties": contracts_selectors.party_identity_snapshot(milestone.contract),
        "occurred_at": timezone.now().isoformat(),
    }
    payload.update(extra)
    return payload


def _customer_materials(milestone: Milestone) -> QuerySet[ContractMaterial]:
    return milestone.materials.filter(source=_SOURCE.CUSTOMER)


def _materials_ready(milestone: Milestone) -> bool:
    """domain-model.md §7.3: материалы `source=contractor` не блокируют —
    исполнитель поставляет их сам в процессе работы; блокируют только
    непереданные материалы `source=customer` (симметрично `problem-notice`,
    который жалуется именно на них).

    ADR-155 смысл НЕ изменил: условие по-прежнему «все материалы заказчика
    получены» (`received=True`). Изменился путь к этому флагу — теперь он
    ставится только ПОСЛЕ отметки «передано» другой стороной
    (`confirm_material_handed_over` -> `confirm_material_received`)."""
    return not _customer_materials(milestone).filter(received=False).exists()


def payment_before_start(contract: Contract) -> bool:
    """ADR-155 (решение владельца 03.09: «просто условие старта этапа —
    оплата»): договор с `payment_order=before_start` оплачивает КАЖДЫЙ лист
    ДО его старта. Отдельный предикат, а не сравнение по месту, — на него
    смотрят и гейт, и платёжный контур (`apps.payments.services` зовёт этот
    фасад, а не читает поле сам)."""
    return contract.payment_order == _PAYMENT_ORDER.BEFORE_START


def _financial_condition(milestone: Milestone) -> tuple[bool, str | None]:
    """tech-spec.md §6.3 «Фин. условие гейта» + ADR-155.

    `payment_order=before_start` (владелец 03.09) — условие старта листа
    ОДНО: оплата ИМЕННО ЭТОГО листа подтверждена обеими сторонами. Способ
    расчёта тут уже не решает: он говорит, ПО КАКИМ РЕЛЬСАМ платят, а не
    когда (ADR-151 §1). Читаются те же зеркала `paid_confirmed_*`, что и у
    постоплаты, — потому что это ОДИН И ТОТ ЖЕ платёж по листу, просто
    выставленный раньше (ADR-155 §3: второго платежа «после приёмки» не
    возникает). Исключение — `direct_platform`/`hold`: платёж не
    наблюдается (партнёра нет), честная заглушка `awaiting_payment`
    остаётся.

    `payment_order=after_acceptance` и `null` (займ; договоры, замороженные
    до ADR-151) — платить ДО старта не надо: `cash`/`external` выполнено по
    умолчанию (метка «без защиты платежа» — на стороне представления),
    `direct_platform`/`hold` — `awaiting_payment` (наблюдать нечем).
    Способа `prepayment` больше нет (ADR-155, владелец 03.09: «предоплата с
    двусторонним подтверждением — там быть не должно») — предоплата живёт
    ровно в одном месте, в `payment_order`.

    Отметки читаются с самого этапа, а не из apps.payments: обратный импорт
    запрещён транзитивным контрактом import-linter (`apps.contracts ->
    apps.milestones -> apps.payments`), а пишет их только платёжный контур
    (`apps.payments.services._mirror_into_milestone`) — расхождения с
    Payment не бывает."""
    method = milestone.contract.payment_method
    if payment_before_start(milestone.contract):
        if method in (_PAYMENT_METHOD.DIRECT_PLATFORM, _PAYMENT_METHOD.HOLD):
            return False, "awaiting_payment"
        if not method:
            return False, "payment_method_not_set"
        ok = (
            milestone.paid_confirmed_by_customer_at is not None
            and milestone.paid_confirmed_by_contractor_at is not None
        )
        return ok, None if ok else "payment_not_confirmed"
    if method in (_PAYMENT_METHOD.CASH, _PAYMENT_METHOD.EXTERNAL):
        return True, None
    if method in (_PAYMENT_METHOD.DIRECT_PLATFORM, _PAYMENT_METHOD.HOLD):
        return False, "awaiting_payment"
    return False, "payment_method_not_set"


#: ADR-155 §2: состояние КАЖДОГО условия гейта (замечание владельца 03.09:
#: «Договор подписан — стоит "Ждем", а 2 других — Готово. Должен быть статус
#: — Ждем тоже»). Булево `met/not met` этого не выражало: «ждём» и «условия
#: нет вовсе» рисовались одинаковым «Готово».
CONDITION_WAITING = "waiting"
CONDITION_MET = "met"
CONDITION_NOT_REQUIRED = "not_required"


def _materials_condition(milestone: Milestone) -> str:
    """`not_required` — у листа НЕТ материалов заказчика: ждать нечего, и
    «Готово» показывать не за что."""
    if not _customer_materials(milestone).exists():
        return CONDITION_NOT_REQUIRED
    return CONDITION_MET if _materials_ready(milestone) else CONDITION_WAITING


def _financial_condition_state(milestone: Milestone, *, met: bool) -> str:
    """`not_required` — только там, где платить ДО старта не надо вовсе:
    постоплата/займ на офлайн-рельсах (`cash`/`external`). При
    `before_start` условие есть ВСЕГДА (в этом и решение владельца), при
    `direct_platform`/`hold` — ожидание платежа: это `waiting`/`met`, а не
    «не требуется»."""
    if payment_before_start(milestone.contract):
        return CONDITION_MET if met else CONDITION_WAITING
    if milestone.contract.payment_method in (_PAYMENT_METHOD.CASH, _PAYMENT_METHOD.EXTERNAL):
        return CONDITION_NOT_REQUIRED
    return CONDITION_MET if met else CONDITION_WAITING


def gate_status(milestone: Milestone) -> dict[str, Any]:
    """`GET /milestones/{id}/gate` и `POST /milestones/{id}/start` читают
    один и тот же расчёт — «честная» видимость причины блокировки ДО
    попытки перехода.

    ADR-155 добавил `conditions` — СОСТОЯНИЕ каждого условия строкой
    (`waiting`/`met`/`not_required`) рядом с прежними булевыми полями:
    старые ключи остались, фронт мигрирует без слома. Пока договор не
    подписан, все три условия — `waiting` (владелец 03.09): до подписи ни
    одно из них не «готово», даже если по данным материалы переданы и
    деньги пришли, — обязательства ещё не возникли."""
    signed = milestone.contract.negotiation_status == Contract.NegotiationStatus.SIGNED
    materials_ready = _materials_ready(milestone)
    financial_ok, financial_reason = _financial_condition(milestone)
    conditions = (
        {
            "signed": CONDITION_MET,
            "materials": _materials_condition(milestone),
            "financial": _financial_condition_state(milestone, met=financial_ok),
        }
        if signed
        else dict.fromkeys(("signed", "materials", "financial"), CONDITION_WAITING)
    )
    return {
        "signed": signed,
        "materials_ready": materials_ready,
        "financial_condition_met": financial_ok,
        "financial_condition_reason": financial_reason,
        "conditions": conditions,
        "can_start": signed and materials_ready and financial_ok,
    }


def _perform_start(milestone: Milestone, *, actor: dict[str, Any], auto: bool) -> Milestone:
    """Общее тело обоих путей входа листа в работу (ADR-162): ручного
    `start_milestone` и автостарта `_try_auto_start`. Переход, отметка
    `started_at` и пара событий не должны различаться по способу вызова —
    иначе дашборды, репутация и архив увидели бы два разных «старта».
    `payload["auto"]` — единственное различие: он говорит, что решение
    приняла система, а не сторона."""
    transition = MILESTONE_FSM.assert_transition("start", milestone.status)
    contract = milestone.contract
    milestone.status = transition.target
    milestone.started_at = timezone.now()
    milestone.save(update_fields=["status", "started_at"])
    subject = {"type": "milestone", "id": str(milestone.id), "contract_id": str(contract.id)}
    # `gate_passed` и `started` (реестр топиков tech-spec.md §6.4) совпадают
    # по моменту в этой ветке — гейт и старт листа неразделимы (нет
    # промежуточного «гейт прошёл, но лист ещё не стартовал» состояния).
    outbox.publish(
        "milestone.gate_passed",
        subject=subject,
        payload=_event_payload(milestone, auto=auto),
        actor=actor,
    )
    outbox.publish(
        "milestone.started",
        subject=subject,
        payload=_event_payload(milestone, auto=auto),
        actor=actor,
    )
    contracts_services.start_execution(contract)
    return milestone


@transaction.atomic
def _try_auto_start(milestone: Milestone) -> Milestone:
    """ADR-162 (владелец 05.09: «Как только выполнены все условия —
    автоматическое начало этапа. сейчас ждёт ручного подтверждения. лишняя
    активность»): лист входит в работу САМ в момент закрытия ПОСЛЕДНЕГО
    условия гейта §6.3. Вызывается в конце каждого сервиса, который это
    условие закрывает, — не сигналом (CLAUDE.md) и не отдельной sweep-
    задачей: момент известен точно, ждать минуты незачем.

    Тихий no-op во всех «не тот случай»-ветках, потому что вызывающая
    сторона делала СВОЁ дело (подтверждала материал, оплату, подпись) и
    падать из-за незакрытого гейта не должна:
    - лист уже не `pending` (стартован ручным `POST /start`, повторной
      доставкой события или параллельным подтверждением) — идемпотентность;
    - ветка дерева, а не лист — ветки не стартуют (домен-инвариант);
    - хоть одно условие ещё `waiting`.

    `select_for_update` на строке листа — гонка двух одновременных
    подтверждений (обе стороны жмут «оплатил» в одну секунду) не должна
    выдать два перехода и две пары событий: второй ждёт блокировки и видит
    уже `in_progress`. Событий у гонки нет: они публикуются под тем же
    замком."""
    locked = (
        Milestone.objects.select_for_update()
        .select_related("contract")
        .filter(pk=milestone.pk, status=_STATUS.PENDING)
        .first()
    )
    if locked is None or locked.children.exists():
        return milestone
    if not gate_status(locked)["can_start"]:
        return milestone
    _perform_start(locked, actor={}, auto=True)
    # Объект вызывающей стороны — тот же лист: синхронизируем, чтобы она
    # вернула наружу актуальный статус, а не прочитанный до автостарта.
    milestone.status = locked.status
    milestone.started_at = locked.started_at
    return milestone


def auto_start_ready_leaves(contract_id: UUID) -> list[Milestone]:
    """ADR-162, путь «подпись закрыла последнее условие»: договор подписан —
    все листья, у которых материалы и деньги уже `met`/`not_required`,
    стартуют сами. Вызывается ПОДПИСЧИКОМ `handlers.handle_contract_signed`
    на топик `contract.signed`, а не из `apps.contracts.services.sign`:
    apps.contracts не имеет права знать про apps.milestones (import-linter,
    зависимость направлена в другую сторону — apps.milestones ->
    apps.contracts). Тот же приём разрыва, что у `handle_dispute_resolved`.

    Идемпотентно по построению: повторная доставка `contract.signed`
    (at-least-once, ADR-064) не найдёт ни одного `pending` листа."""
    started: list[Milestone] = []
    leaves = Milestone.objects.filter(contract_id=contract_id, status=_STATUS.PENDING)
    for leaf in leaves.select_related("contract").order_by("order", "id"):
        if _try_auto_start(leaf).status == _STATUS.IN_PROGRESS:
            started.append(leaf)
    return started


@transaction.atomic
def start_milestone(milestone: Milestone, *, user: User) -> Milestone:
    """`POST /milestones/{id}/start` — вне таблицы tech-spec.md §8.5 (гейт
    §6.3 описан как ПРЕДИКАТ `can_start()`, не как готовый эндпоинт; этот
    добавлен явным дискретным шагом — приёмка etap-4.md Э4.6 перечисляет
    «две подписи -> гейт (cash)» отдельным пунктом сценария, тот же приём,
    что `POST .../milestones/loan-schedule` в Э4.3). Идемпотентно на уже
    `in_progress` листе (несколько независимых листьев могут пройти гейт
    «одновременно»).

    ADR-162 оставил эндпоинт, но сделал его РЕДКИМ: обычно лист стартует
    сам (`_try_auto_start`), и сюда приходят только рассинхрон фронта и
    e2e/обратная совместимость. Поэтому идемпотентность на `in_progress`
    важнее прежнего: типичный ручной вызов теперь — вызов «вдогонку»."""
    contract = milestone.contract
    contracts_services.get_party_for_user(contract, user)
    if milestone.status == _STATUS.IN_PROGRESS:
        return milestone
    _assert_leaf(milestone)
    MILESTONE_FSM.assert_transition("start", milestone.status)

    status_report = gate_status(milestone)
    if not status_report["signed"]:
        raise GateNotSignedError(f"договор {contract.id} ещё не подписан")
    if not status_report["materials_ready"]:
        raise GateMaterialsNotReadyError(
            f"этап {milestone.id}: не все материалы заказчика получены"
        )
    if not status_report["financial_condition_met"]:
        raise GateFinancialConditionNotMetError(
            f"этап {milestone.id}: финансовое условие не выполнено "
            f"({status_report['financial_condition_reason']})",
            reason=status_report["financial_condition_reason"],
        )

    return _perform_start(milestone, actor={"user_id": str(user.id)}, auto=False)


@transaction.atomic
def raise_material_problem(material: ContractMaterial, *, user: User, reason: str) -> Milestone:
    """`POST /materials/{id}/problem-notice` (tech-spec.md §8.5, ADR-019):
    уведомление о проблеме с материалом заказчика -> окно оспаривания через
    deadlines, этап приостанавливается. ADR-019: одностороннее утверждение
    НЕ санкция — окно (здесь: структурная запись дедлайна; отдельного
    эндпоинта «оспорить» tech-spec.md не перечисляет — счёт-факт фиксируется
    самим наступлением дедлайна, `apps.deadlines.tasks.sweep_domain_
    deadlines`, без дополнительного действия apps.milestones)."""
    milestone = material.milestone
    contract = milestone.contract
    contracts_services.get_party_for_user(contract, user)
    if material.source != _SOURCE.CUSTOMER:
        raise MaterialProblemNotOnCustomerSourceError(
            f"материал {material.id} поставляется исполнителем — жаловаться некому"
        )
    _assert_leaf(milestone)
    transition = MILESTONE_FSM.assert_transition("suspend", milestone.status)
    milestone.status = transition.target
    milestone.save(update_fields=["status"])

    now = timezone.now()
    deadlines_services.create_deadline(
        kind=_SUSPENSION_DEADLINE_KIND,
        subject_type="milestone",
        subject_id=milestone.id,
        starts_from="event",
        anchor_at=now,
    )
    other = contracts_selectors.party_user(contracts_selectors.resolve_counterparty(contract, user))
    if other is not None:
        notifications_services.place_notification(
            recipient=other,
            template="milestone_material_notice",
            payload={"material_id": str(material.id), "reason": reason},
            legal_significance=True,
        )
    outbox.publish(
        "milestone.suspended",
        subject={"type": "milestone", "id": str(milestone.id), "contract_id": str(contract.id)},
        payload=_event_payload(
            milestone,
            material_id=str(material.id),
            reason=reason,
            raised_by_user_id=str(user.id),
        ),
        actor={"user_id": str(user.id)},
    )
    return milestone


def shift_dependent_deadlines(milestone: Milestone, *, by_days: int) -> None:
    """«frozen_days сдвигает последующие дедлайны — общий сервис»
    (etap-4.md Э4.6): «последующие» — этапы, ЗАВИСЯЩИЕ от этого
    (`Milestone.depends_on`, прямые, без рекурсии по цепочке — простой
    случай для этой ветки). Двигает и `DomainDeadline` (через общий
    `apps.deadlines.services.shift_deadlines_for_subjects`), и человеко-
    читаемое поле `Milestone.deadline` самих зависимых этапов."""
    if by_days <= 0:
        return
    dependent_ids = list(
        Milestone.objects.filter(depends_on=milestone).values_list("id", flat=True)
    )
    if not dependent_ids:
        return
    delta = timedelta(days=by_days)
    deadlines_services.shift_deadlines_for_subjects(
        subject_type="milestone", subject_ids=dependent_ids, by=delta
    )
    for dependent in Milestone.objects.filter(id__in=dependent_ids, deadline__isnull=False):
        # `deadline__isnull=False` в фильтре гарантирует не-None в рантайме,
        # mypy этого из QuerySet-фильтра не выводит.
        assert dependent.deadline is not None
        dependent.deadline = dependent.deadline + delta
        dependent.save(update_fields=["deadline"])


def _assert_material_side(material: ContractMaterial, *, user: User, expected_role: str) -> None:
    """ADR-155: сторона материала. `source` называет, КТО поставляет, —
    значит он же отмечает «передал»; принимает всегда другая сторона."""
    party = contracts_services.get_party_for_user(material.milestone.contract, user)
    if party.role != expected_role:
        raise MaterialHandoverWrongSideError(
            f"материал {material.id} (source={material.source!r}): действие доступно "
            f"стороне {expected_role!r}, а пользователь {user.id} — {party.role!r}"
        )


def _material_counter_role(material: ContractMaterial) -> str:
    return _ROLE.CONTRACTOR if material.source == _SOURCE.CUSTOMER else _ROLE.CUSTOMER


@transaction.atomic
def confirm_material_handed_over(material: ContractMaterial, *, user: User) -> ContractMaterial:
    """`POST /materials/{id}/handed-over` (ADR-155) — сигнал стороны-
    источника «передал». Гейт этапа им не двигается (`_materials_ready`
    смотрит на `received`): заявление одной стороны — не факт (тот же
    принцип, что ADR-019 для `problem-notice`). Шаг НЕОБЯЗАТЕЛЕН —
    принимающая сторона может отметить получение и без него (владелец
    03.09), но он даёт заказчику способ сказать «я привёз» и запустить
    уведомление контрагенту.

    Идемпотентно: повторный вызов — no-op с текущим состоянием (кнопка
    переживает двойной клик, как `confirm_by_payer` в apps.payments)."""
    milestone = material.milestone
    contract = milestone.contract
    _assert_material_side(material, user=user, expected_role=material.source)
    if material.handed_over_at is not None:
        return material

    material.handed_over_at = timezone.now()
    material.handed_over_by = user
    material.save(update_fields=["handed_over_at", "handed_over_by"])
    outbox.publish(
        "milestone.material_handed_over",
        subject={"type": "milestone", "id": str(milestone.id), "contract_id": str(contract.id)},
        payload=_event_payload(milestone, material_id=str(material.id), source=material.source),
        actor={"user_id": str(user.id)},
    )
    return material


@transaction.atomic
def confirm_material_received(material: ContractMaterial, *, user: User) -> ContractMaterial:
    """`POST /materials/{id}/received` (tech-spec.md §8.5): «подтверждение
    получения -> разморозка зависимых этапов». Если материал был блокером
    гейта СУСПЕНДИРОВАННОГО этапа — резюмирует его: `frozen_days` +=
    накопленный простой (от якоря окна оспаривания до этого момента),
    последующие дедлайны сдвигаются на ту же величину (`shift_dependent_
    deadlines`).

    ADR-155: отметить получение может ТОЛЬКО сторона, которой передают (не
    источник) — иначе поставщик материалов открывал бы гейт этапа сам себе.
    Предварительное «передано» при этом НЕ требуется (уточнение владельца
    03.09: «Исполнитель может в одностороннем порядке поставить "получены".
    Сделаем жизнь людям чуть легче»): получение — факт со стороны, которой
    он невыгоден, и заставлять её ждать чужой кнопки незачем."""
    milestone = material.milestone
    contract = milestone.contract
    _assert_material_side(material, user=user, expected_role=_material_counter_role(material))

    if not material.received:
        material.received_by = user
        material.received = True
        material.received_at = timezone.now()
        material.save(update_fields=["received", "received_at", "received_by"])
        outbox.publish(
            "milestone.material_received",
            subject={
                "type": "milestone",
                "id": str(milestone.id),
                "contract_id": str(contract.id),
            },
            payload=_event_payload(milestone, material_id=str(material.id)),
            actor={"user_id": str(user.id)},
        )

    if milestone.status == _STATUS.SUSPENDED and _materials_ready(milestone):
        transition = MILESTONE_FSM.assert_transition("resume", milestone.status)
        now = timezone.now()
        suspension = (
            deadlines_selectors.list_active_for_subject(
                subject_type="milestone", subject_id=milestone.id
            )
            .filter(kind=_SUSPENSION_DEADLINE_KIND)
            .order_by("-anchor_at")
            .first()
        )
        frozen_days_delta = 0
        if suspension is not None and suspension.anchor_at is not None:
            frozen_days_delta = max((now - suspension.anchor_at).days, 0)
            deadlines_services.pause_deadline(suspension, reason="resolved_by_material_delivery")

        milestone.status = transition.target
        milestone.frozen_days = milestone.frozen_days + frozen_days_delta
        milestone.save(update_fields=["status", "frozen_days"])
        shift_dependent_deadlines(milestone, by_days=frozen_days_delta)
        outbox.publish(
            "milestone.resumed",
            subject={
                "type": "milestone",
                "id": str(milestone.id),
                "contract_id": str(contract.id),
            },
            payload=_event_payload(milestone, frozen_days_added=frozen_days_delta),
            actor={"user_id": str(user.id)},
        )
    # ADR-162: полученный материал мог быть ПОСЛЕДНИМ незакрытым условием
    # гейта — тогда лист входит в работу здесь же, без отдельной кнопки.
    # На `suspended`-ветке выше это no-op: там лист уже не `pending`.
    _try_auto_start(milestone)
    return material


@transaction.atomic
def submit_milestone(milestone: Milestone, *, user: User, comment: str = "") -> Milestone:
    """`POST /milestones/{id}/submit` (tech-spec.md §8.5) — ФОРМАЛЬНАЯ сдача,
    единственный путь в `under_acceptance` (§16.2 спеки). Якорь дедлайна
    приёмки — РАЗМЕЩЕНИЕ УВЕДОМЛЕНИЯ В ЛК (`place_notification`, ADR-057),
    не сам вызов `submit` — `starts_from=cabinet_placement`.

    ADR-164 (решение владельца 05.09): непокрытые `required_evidence` СДАЧУ
    НЕ БЛОКИРУЮТ. Раньше здесь стоял жёсткий гейт (422
    `required_evidence_not_covered`), и он останавливал сдачу целиком, если
    хоть к одному пункту чек-листа не приложили фото. Кто судит о полноте
    работы — ЗАКАЗЧИК на приёмке: у него есть и отклонение по конкретному
    пункту (`reject`, ADR-017), и непокрытые пункты теперь помечены
    (`selectors.uncovered_required_evidence` в карточке этапа). Исполнителю
    тот же список показывается мягким предупреждением в диалоге сдачи."""
    contract = milestone.contract
    contracts_services.get_party_for_user(contract, user)
    _assert_leaf(milestone)
    transition = MILESTONE_FSM.assert_transition("submit", milestone.status)

    now = timezone.now()
    milestone.status = transition.target
    milestone.submitted_at = now
    milestone.save(update_fields=["status", "submitted_at"])

    deadlines_services.create_deadline(
        kind=_ACCEPTANCE_DEADLINE_KIND,
        subject_type="milestone",
        subject_id=milestone.id,
        starts_from="cabinet_placement",
        duration=_acceptance_window(contract),
    )
    customer_party = contract.parties.select_related("profile__owner_entity").get(
        role=_ROLE.CUSTOMER
    )
    customer_user = contracts_selectors.party_user(customer_party)
    if customer_user is not None:
        # place_notification якорит незаякоренный дедлайн ВЫШЕ (тот же
        # subject) и стартует «усиленную серию напоминаний» из
        # ReminderPointConfig(kind="milestone_acceptance") — механизм уже
        # сконфигурирован ЭФ.4 (apps/notifications/migrations/0002).
        notifications_services.place_notification(
            recipient=customer_user,
            template="milestone_submitted_for_acceptance",
            payload={"milestone_id": str(milestone.id), "comment": comment},
            legal_significance=True,
            subject_type="milestone",
            subject_id=str(milestone.id),
        )
    outbox.publish(
        "milestone.submitted",
        subject={"type": "milestone", "id": str(milestone.id), "contract_id": str(contract.id)},
        payload=_event_payload(milestone, comment=comment),
        actor={"user_id": str(user.id)},
    )
    return milestone


def _active_acceptance_deadlines(milestone: Milestone) -> QuerySet[Any]:
    """Ещё не сработавшие и не закрытые дедлайны `milestone_acceptance`
    этапа (в штатном потоке — не больше одного: каждое закрытие окна ниже
    гасит предыдущий до того, как `return_to_acceptance_after_fix` заведёт
    новый). `QuerySet[Any]` — DomainDeadline остаётся классом apps.deadlines
    и сюда не импортируется (тот же приём, что в apps.notifications.services:
    общение через фасады selectors/services, не через чужие модели)."""
    return deadlines_selectors.list_active_for_subject(
        subject_type="milestone", subject_id=milestone.id
    ).filter(kind=_ACCEPTANCE_DEADLINE_KIND)


def _acceptance_on_time(milestone: Milestone, *, at: datetime) -> bool | None:
    deadline = _active_acceptance_deadlines(milestone).order_by("-anchor_at").first()
    if deadline is None or deadline.deadline_at is None:
        return None
    return bool(at <= deadline.deadline_at)


def _close_acceptance_window(milestone: Milestone, *, outcome: str) -> int:
    """Окно приёмки снято решением заказчика (accept/reject) — дедлайн
    `milestone_acceptance` закрывается досрочно (`deadlines_services.
    close_deadline`: fired_at + outcome без события `domain_deadline.fired`).
    Иначе строка оставалась бы активной до истечения 48 ч: свип дедлайнов
    выстрелил бы её вхолостую (автоприёмка уже принятого этапа — NOOP по
    статусу в `handlers.handle_deadline_fired`), а `apps.notifications.
    tasks.sweep_reminder_schedules` всё это время слал бы заказчику
    оставшиеся точки усиленной серии «примите этап» (50/75/90/99 %,
    `ReminderPointConfig(kind="milestone_acceptance")`) по уже принятому
    или отклонённому этапу. Обе выборки свипов — `fired_at IS NULL`, так
    что закрытия достаточно.

    Незаякоренный дедлайн (заказчик без пользователя — `place_notification`
    не вызывалось, deadline_at IS NULL) закрывается так же: активным ему
    больше быть не за чем. Уже сработавший (автоприёмка по свипу) в выборку
    не попадает — закрывать нечего, повторный вызов идемпотентен.
    Возвращает число закрытых строк."""
    closed = 0
    for deadline in _active_acceptance_deadlines(milestone):
        deadlines_services.close_deadline(deadline, outcome=outcome)
        closed += 1
    return closed


@transaction.atomic
def finalize_acceptance(milestone: Milestone, *, actor_user: User | None, auto: bool) -> Milestone:
    now = timezone.now()
    transition = MILESTONE_FSM.assert_transition("accept", milestone.status)
    on_time = _acceptance_on_time(milestone, at=now)
    # После вычисления on_time (тому нужен ещё активный дедлайн): ручная
    # приёмка закрывает окно; при автоприёмке дедлайн уже сработал по
    # свипу, при приёмке по исходу спора — закрыт ещё в reject_milestone.
    _close_acceptance_window(milestone, outcome=_ACCEPTANCE_OUTCOME_ACCEPTED)
    milestone.status = transition.target
    if milestone.accepted_at is None:
        milestone.accepted_at = now
    milestone.save(update_fields=["status", "accepted_at"])

    topic = "milestone.auto_accepted" if auto else "milestone.accepted"
    # ADR-178: `actor_user` — None и для авто-приёмки (apps.milestones.
    # handlers, дедлайн-свип, системное действие), и для приёмки по исходу
    # спора (apps.milestones.handlers.handle_dispute_resolved, тоже без
    # реального пользователя) — оставляем событие БЕЗ actor.user_id как есть,
    # фолбэк на заказчика больше не нужен и не подставляется. До ADR-178 этот
    # фолбэк был нужен, чтобы уведомление вообще дошло: тогдашний реестр
    # «актора» требовал явного actor.user_id. Теперь такое системное событие
    # без актора уходит ОБЕИМ сторонам через settings.NOTIFICATION_TOPIC_
    # COUNTERPARTY_TEMPLATES (пустой актор = никто не исключён из сторон
    # договора) — «свип дедлайнов, авто-исход спора» из перечня системных
    # событий ADR-178, а не «моё действие» одной стороны. Явную ручную
    # приёмку (`actor_user` задан) это не меняет — она остаётся действием
    # заказчика, и он её карточку больше не получает (та же причина, что и
    # у остального контура ADR-178).
    event_actor = actor_user
    outbox.publish(
        topic,
        subject={
            "type": "milestone",
            "id": str(milestone.id),
            "contract_id": str(milestone.contract_id),
        },
        # ADR-163 §1: `auto_accepted` — автоприёмка по тайм-ауту. Для
        # исполнителя это принятый этап, для ЗАКАЗЧИКА — «не принято без
        # затягивания»: два разных факта об одном событии, и топик
        # `milestone.auto_accepted` их не различает (на него подписаны и те,
        # кому важен только сам факт приёмки).
        payload=_event_payload(
            milestone, on_time=on_time, accepted_at=now.isoformat(), auto_accepted=auto
        ),
        actor={"user_id": str(event_actor.id)} if event_actor is not None else {},
    )
    # ADR-155 (`payment_order=before_start`): деньги по листу пришли ДО
    # старта, приёмка — последнее недостающее условие, поэтому лист
    # закрывается оплаченным ТУТ ЖЕ. Так `accepted` не становится
    # терминальным состоянием для половины договоров: `complete_execution`
    # (все листья `paid` -> completed -> warranty), дашборд «Платежи»,
    # репутация и архив продолжают опираться на `milestone.paid`, как
    # прежде, и не учат второй способ «этап закрыт». Второй оплаты по листу
    # при этом не запрашивается — постоплата для `before_start` не
    # выставляется вовсе (apps.payments.services.ensure_contract_payments).
    if payment_before_start(milestone.contract) and _payment_mirrors_complete(milestone):
        _settle_paid(milestone, actor_user=event_actor)
    return milestone


@transaction.atomic
def accept_milestone(milestone: Milestone, *, user: User) -> Milestone:
    """`POST /milestones/{id}/accept` (tech-spec.md §8.5) — явная приёмка
    заказчиком."""
    contract = milestone.contract
    party = contracts_services.get_party_for_user(contract, user)
    if party.role != _ROLE.CUSTOMER:
        raise contracts_services.NotAPartyError(
            f"пользователь {user.id} не заказчик этапа {milestone.id} — принять может только он"
        )
    MILESTONE_FSM.assert_transition("accept", milestone.status)  # ранняя 409 до side-effects
    return finalize_acceptance(milestone, actor_user=user, auto=False)


@transaction.atomic
def reject_milestone(
    milestone: Milestone, *, user: User, checklist_item_id: UUID | None, evidence: list[str]
) -> Milestone:
    """`POST /milestones/{id}/reject` (tech-spec.md §8.5, ADR-017): ТОЛЬКО с
    `checklist_item_id` + `evidence` — иначе `422 checklist_item_required`.

    НЕ вызывает `apps.disputes` напрямую — import-linter [[tool.
    importlinter.contracts]] «contracts не импортирует payments/disputes»
    запрещает это ТРАНЗИТИВНО: apps.contracts.services уже импортирует
    apps.milestones.services (отложенно, `freeze_contract`/`apply_amendment`
    /`effective_terms`) — прямой импорт apps.disputes здесь протащил бы
    apps.contracts -> apps.milestones -> apps.disputes, ломая контракт.
    Спор-заглушка открывается АСИНХРОННО подписчиком `apps.disputes.
    handlers.handle_milestone_rejected` на топик `milestone.rejected`
    (`settings.OUTBOX_SUBSCRIBERS`) — тот же приём разрыва цикла, что
    `apps.profiles` на `entity.claimed` (outbox, не прямой импорт)."""
    contract = milestone.contract
    party = contracts_services.get_party_for_user(contract, user)
    if party.role != _ROLE.CUSTOMER:
        raise contracts_services.NotAPartyError(
            f"пользователь {user.id} не заказчик этапа {milestone.id} — отклонить может только он"
        )
    if not checklist_item_id:
        raise ChecklistItemRequiredError(
            "отклонение требует checklist_item_id (ADR-017) — 422 checklist_item_required"
        )
    checklist_item = selectors.get_checklist_item_or_404(checklist_item_id)
    if checklist_item.milestone_id != milestone.id:
        raise ChecklistItemNotOnMilestoneError(
            f"пункт чек-листа {checklist_item.id} не из этапа {milestone.id}"
        )
    if not evidence:
        raise EvidenceRequiredError("отклонение требует хотя бы одно доказательство (ADR-017)")
    transition = MILESTONE_FSM.assert_transition("reject", milestone.status)

    milestone.status = transition.target
    milestone.save(update_fields=["status"])
    # Этап уходит в `disputed` — окно приёмки закрыто, напоминания «примите
    # этап» по нему больше не уходят; новое окно (и новая серия) — только
    # при `resubmit_fix` (`return_to_acceptance_after_fix`).
    _close_acceptance_window(milestone, outcome=_ACCEPTANCE_OUTCOME_REJECTED)
    outbox.publish(
        "milestone.rejected",
        subject={"type": "milestone", "id": str(milestone.id), "contract_id": str(contract.id)},
        payload=_event_payload(
            milestone,
            checklist_item_id=str(checklist_item.id),
            # ADR-163 §6: человеческое «почему вернули» для раскрытия в
            # Insights — без него там стоял бы голый id пункта.
            checklist_item_description=checklist_item.description,
            evidence=evidence,
        ),
        actor={"user_id": str(user.id)},
    )
    return milestone


@transaction.atomic
def return_to_acceptance_after_fix(
    milestone: Milestone, *, contractor_user: User | None
) -> Milestone:
    """Этап 7 (ADR-131, tech-spec.md §8.8): исполнитель сдал исправление по
    раунду спора — `disputed -> under_acceptance`. Вызывается ПОДПИСЧИКОМ
    `handlers.handle_dispute_fix_resubmitted` на `dispute.fix_resubmitted`
    (apps.disputes не импортирует apps.milestones.services — см. докстринг
    `reject_milestone`), поэтому проверки стороны здесь нет: их уже сделал
    `apps.disputes.services.resubmit_fix`.

    Окно приёмки открывается ЗАНОВО, как при первой сдаче: новый дедлайн
    `milestone_acceptance` со `starts_from=cabinet_placement` + размещение
    уведомления заказчику (ADR-057 — отсчёт от юридической доставки, а не
    от вызова). Иначе повторная приёмка шла бы без таймера и без усиленной
    серии напоминаний, то есть автоприёмка после исправления никогда бы не
    наступила."""
    contract = milestone.contract
    transition = MILESTONE_FSM.assert_transition("resubmit_fix", milestone.status)
    now = timezone.now()
    milestone.status = transition.target
    milestone.submitted_at = now
    milestone.save(update_fields=["status", "submitted_at"])

    deadlines_services.create_deadline(
        kind=_ACCEPTANCE_DEADLINE_KIND,
        subject_type="milestone",
        subject_id=milestone.id,
        starts_from="cabinet_placement",
        duration=_acceptance_window(contract),
    )
    customer_party = (
        contract.parties.select_related("profile__owner_entity").filter(role=_ROLE.CUSTOMER).first()
    )
    customer_user = contracts_selectors.party_user(customer_party) if customer_party else None
    if customer_user is not None:
        notifications_services.place_notification(
            recipient=customer_user,
            template="milestone_submitted_for_acceptance",
            payload={"milestone_id": str(milestone.id), "comment": ""},
            legal_significance=True,
            subject_type="milestone",
            subject_id=str(milestone.id),
        )
    outbox.publish(
        "milestone.submitted",
        subject={"type": "milestone", "id": str(milestone.id), "contract_id": str(contract.id)},
        payload=_event_payload(milestone, after_fix_round=True),
        actor={"user_id": str(contractor_user.id)} if contractor_user is not None else {},
    )
    return milestone


def _all_leaves(contract: Contract) -> list[Milestone]:
    cmap = selectors.children_map(contract)

    def _walk(node: Milestone) -> list[Milestone]:
        children = cmap.get(node.id, [])
        if not children:
            return [node]
        return [leaf for child in children for leaf in _walk(child)]

    return [leaf for root in cmap.get(None, []) for leaf in _walk(root)]


def _payment_mirrors_complete(milestone: Milestone) -> bool:
    return (
        milestone.paid_confirmed_by_customer_at is not None
        and milestone.paid_confirmed_by_contractor_at is not None
    )


def _settle_paid(milestone: Milestone, *, actor_user: User | None) -> Milestone:
    """`accepted -> paid` + `milestone.paid` + завершение исполнения, когда
    ВСЕ листья оплачены. Общее тело двух путей закрытия листа (ADR-155):
    постоплата закрывает его в `confirm_payment` (деньги пришли ПОСЛЕ
    приёмки), предоплата — в `finalize_acceptance` (деньги пришли ДО старта,
    приёмка — последнее недостающее). Один и тот же переход, одно и то же
    событие: дашборды, репутация и архив не должны различать, каким путём
    лист стал `paid`."""
    contract = milestone.contract
    transition = MILESTONE_FSM.assert_transition("pay", _STATUS.ACCEPTED)
    milestone.status = transition.target
    milestone.save(update_fields=["status"])
    outbox.publish(
        "milestone.paid",
        subject={"type": "milestone", "id": str(milestone.id), "contract_id": str(contract.id)},
        payload=_event_payload(milestone, payment_method=contract.payment_method),
        actor={"user_id": str(actor_user.id)} if actor_user is not None else {},
    )
    # `milestone.status` уже сохранён (`PAID`) строкой выше — свежий запрос
    # `_all_leaves` читает его тем же SELECT, что и остальные листья,
    # отдельного случая для «этого» листа не нужно.
    leaves = _all_leaves(contract)
    if leaves and all(leaf.status == _STATUS.PAID for leaf in leaves):
        contracts_services.complete_execution(contract)
    return milestone


@transaction.atomic
def confirm_payment(
    milestone: Milestone,
    *,
    user: User,
    side: str,
    payment_due_at: datetime | None = None,
) -> Milestone:
    """Двустороннее подтверждение оплаты листа (tech-spec.md §8.7
    `/payments/{id}/confirm`). При постоплате это `accepted -> paid`; когда
    ПОСЛЕДНИЙ лист договора становится `paid` — `apps.contracts.services.
    complete_execution` (in_progress -> completed -> warranty).

    ADR-155, `payment_order=before_start`: тот же вызов обслуживает оплату
    ДО старта листа — статус листа при этом `pending` (или любой рабочий),
    и переводить его в `paid` НЕЛЬЗЯ: работа ещё не сдана. Поэтому проверка
    «лист принят» здесь применяется только к постоплате, а закрытие листа
    берёт на себя приёмка (`finalize_acceptance` -> `_settle_paid`). Новых
    статусов Milestone предоплата не вводит — меняется только
    последовательность (решение владельца 03.09).

    ADR-130 (Э5): зеркало, а не источник правды — денежный факт живёт в
    `apps.payments.models.Payment`, единственный писатель зеркала —
    `apps.payments.services._mirror_into_milestone` (в одной транзакции с
    платежом). HTTP-эндпоинт
    `POST /milestones/{id}/confirm-payment` (URL и контракт не менялись)
    обслуживает `apps.payments.api.views.MilestoneConfirmPaymentView`."""
    contract = milestone.contract
    party = contracts_services.get_party_for_user(contract, user)
    if party.role != side:
        raise WrongConfirmationSideError(
            f"пользователь {user.id} действует как {party.role!r}, не {side!r}"
        )
    before_start = payment_before_start(contract)
    if not before_start and milestone.status != _STATUS.ACCEPTED:
        MILESTONE_FSM.assert_transition("pay", milestone.status)  # для читаемой 409-ошибки

    now = timezone.now()
    field = (
        "paid_confirmed_by_customer_at"
        if side == _ROLE.CUSTOMER
        else "paid_confirmed_by_contractor_at"
    )
    setattr(milestone, field, now)
    milestone.save(update_fields=[field])
    outbox.publish(
        "milestone.payment_confirmed",
        subject={"type": "milestone", "id": str(milestone.id), "contract_id": str(contract.id)},
        # ADR-163 §6 (ось заказчика «оплачено в срок»): срок оплаты
        # приходит СВЕРХУ, параметром из `apps.payments.services.
        # _mirror_into_milestone` — `apps.milestones` не импортирует
        # apps.payments (контракт import-linter, ADR-130), а дедлайн
        # `payment_settlement` висит на `Payment`, не на этапе.
        payload=_event_payload(
            milestone,
            side=side,
            payment_due_at=payment_due_at.isoformat() if payment_due_at else None,
            confirmed_at=now.isoformat(),
        ),
        actor={"user_id": str(user.id)},
    )

    if _payment_mirrors_complete(milestone) and milestone.status == _STATUS.ACCEPTED:
        # `before_start` доходит сюда только в «опоздавшем» сценарии: лист
        # уже принят, а вторая сторона подтвердила оплату лишь теперь
        # (гейт старта его пропустил бы не по этому пути — см. спор).
        _settle_paid(milestone, actor_user=user)
    # ADR-162: при `before_start` вторая отметка об оплате закрывает
    # финансовое условие — если материалы уже получены, лист стартует сам.
    # При постоплате это no-op: там лист либо давно `in_progress`, либо
    # `accepted` строкой выше.
    _try_auto_start(milestone)
    return milestone
