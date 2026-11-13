"""Read-слой apps.milestones. Глубина дерева ≤ MAX_TREE_DEPTH (models.py) —
загрузка целиком одним запросом и разбор в памяти дешевле recursive CTE
при таком ограничении высоты (tech-spec.md §5.2.5 «запросы по дереву —
recursive CTE» описывает общий подход для потенциально больших деревьев;
здесь высота гарантированно мала, N children на практике тоже)."""

from __future__ import annotations

from collections.abc import Iterable
from decimal import Decimal
from typing import Any
from uuid import UUID

from django.db.models import QuerySet
from django.shortcuts import get_object_or_404
from django.utils import timezone

from apps.contracts import selectors as contracts_selectors
from apps.contracts.models import Contract, ContractParty
from apps.deadlines import selectors as deadlines_selectors
from apps.evidence import selectors as evidence_selectors
from common.models import OutboxEvent
from common.money import Money, assert_single_currency

from .models import ChecklistItem, ContractMaterial, Milestone

_ACCEPTANCE_DEADLINE_KIND = "milestone_acceptance"


def get_milestone_or_404(milestone_id: UUID) -> Milestone:
    return get_object_or_404(
        Milestone.objects.select_related("contract", "sphere"), pk=milestone_id
    )


def list_contract_milestones(contract: Contract) -> QuerySet[Milestone]:
    return contract.milestones.select_related("sphere").order_by("order", "created_at")


def find_contract_milestone(contract: Contract, milestone_id: UUID) -> Milestone | None:
    """Этап ЭТОГО договора по id или `None` (ADR-157). Фасад для
    apps.contracts: структурный `item_ref` вида `milestone.<uuid>.<поле>`
    обязан проверить принадлежность цели договору, а импортировать
    `Milestone` в apps.contracts значило бы читать чужую модель напрямую
    (CLAUDE.md: приложения общаются через фасады). `None` вместо 404 —
    решение «чей это адрес» принимает вызывающий: у правки это `422
    revision_item_unknown`, а не 404 страницы."""
    return Milestone.objects.filter(pk=milestone_id, contract=contract).first()


def find_contract_material(contract: Contract, material_id: UUID) -> ContractMaterial | None:
    """Материал ЭТОГО договора по id или `None` — пара к
    `find_contract_milestone` для адресов `material.<uuid>.<поле>` (ADR-157)."""
    return (
        ContractMaterial.objects.select_related("milestone")
        .filter(pk=material_id, milestone__contract=contract)
        .first()
    )


def has_children(milestone: Milestone) -> bool:
    """«Этап — ветка» одним запросом. Фасад для apps.contracts (ADR-157):
    суммы, материалы и приёмка живут только на ЛИСТЬЯХ (tech-spec.md §6.1),
    и правку суммы ветки надо отклонять на предложении, а не на применении."""
    return milestone.children.exists()


def children_map(contract: Contract) -> dict[UUID | None, list[Milestone]]:
    """Все этапы договора одним запросом, сгруппированные по `parent_id`
    (`None` — корни) — общий строительный блок для build_tree и
    apps.milestones.services.total_leaf_amount."""
    by_parent: dict[UUID | None, list[Milestone]] = {}
    for m in list_contract_milestones(contract):
        by_parent.setdefault(m.parent_id, []).append(m)
    return by_parent


def is_leaf(milestone: Milestone, *, children_map: dict[UUID | None, list[Milestone]]) -> bool:
    return not children_map.get(milestone.id)


def computed_amount(
    milestone: Milestone, *, children_map: dict[UUID | None, list[Milestone]]
) -> Money:
    """domain-model.md §7.1 `computed_amount`: у листа — собственный `amount`;
    у ветки — сумма дочерних (рекурсивно). Валюта единая по договору
    (`assert_single_currency` — CLAUDE.md: у денег нет валюты по умолчанию,
    но в пределах одного договора она одна, tech-spec.md §5.2.5)."""
    children = children_map.get(milestone.id, [])
    if not children:
        if milestone.amount is None or milestone.amount_currency is None:
            raise ValueError(f"лист {milestone.id} без amount — незаполненная структура")
        return Money(milestone.amount, milestone.amount_currency)
    child_amounts = [computed_amount(child, children_map=children_map) for child in children]
    currency = assert_single_currency(child_amounts)
    total = sum((m.amount for m in child_amounts), start=Decimal("0"))
    return Money(total, currency)


def build_tree(contract: Contract) -> list[dict[str, Any]]:
    """GET /contracts/{id}/milestones?view=tree (tech-spec.md §8.5): дерево
    с вычисленными суммами/признаком листа у каждого узла."""
    cmap = children_map(contract)
    roots = cmap.get(None, [])

    def _node(m: Milestone) -> dict[str, Any]:
        leaf = is_leaf(m, children_map=cmap)
        try:
            amount = computed_amount(m, children_map=cmap)
        except ValueError:
            amount = None
        return {
            # str(...) — тот же приём, что "amount" ниже: этот dict уходит в
            # Response() напрямую, БЕЗ Serializer.to_representation()
            # (в отличие от MilestoneSerializer, где UUIDField сам
            # приводит к строке) — по проводу JSONRenderer всё равно
            # стрингует UUID, но `resp.data` в тестах/до рендера отдавал бы
            # сырой UUID и не совпадал бы с id из MilestoneSerializer
            # (str) при прямом сравнении.
            "id": str(m.id),
            "parent_id": str(m.parent_id) if m.parent_id is not None else None,
            "order": m.order,
            "title": m.title,
            "status": m.status,
            "is_leaf": leaf,
            "amount": str(amount.amount) if amount else None,
            "currency": amount.currency if amount else None,
            "sphere_code": m.sphere.code if m.sphere is not None else None,
            "deadline": m.deadline,
            "depends_on_id": str(m.depends_on_id) if m.depends_on_id is not None else None,
            "frozen_days": m.frozen_days,
            "submitted_at": m.submitted_at,
            "accepted_at": m.accepted_at,
            "children": [_node(child) for child in cmap.get(m.id, [])],
        }

    return [_node(root) for root in sorted(roots, key=lambda m: m.order)]


def get_checklist_item_or_404(checklist_item_id: UUID) -> ChecklistItem:
    return get_object_or_404(
        ChecklistItem.objects.select_related("milestone__contract"), pk=checklist_item_id
    )


def list_checklist_items(milestone: Milestone) -> QuerySet[ChecklistItem]:
    return milestone.checklist_items.order_by("order", "created_at")


def uncovered_required_evidence(milestone: Milestone) -> list[UUID]:
    """ADR-164: пункты чек-листа этапа, которые ПРОСЯТ доказательство
    (`required_evidence` непустой) и ни одного файла к себе не получили — в
    порядке чек-листа, чтобы список читался как сам чек-лист.

    Это ПОДСКАЗКА, а не запрет: сдачу этапа непокрытые пункты не блокируют
    (решение владельца 05.09). Исполнителю список нужен для мягкого
    предупреждения в диалоге «Сдать этап», заказчику — чтобы при приёмке
    видеть, к каким пунктам фото не приложили.

    Этап без «фотопунктов» вовсе (пустой или целиком необязательный
    чек-лист — обычный случай) обходится одним запросом, без второго.
    """
    item_ids = [item.id for item in list_checklist_items(milestone) if item.required_evidence]
    if not item_ids:
        return []
    uncovered = evidence_selectors.uncovered_checklist_items(checklist_item_ids=item_ids)
    return [item_id for item_id in item_ids if item_id in uncovered]


def get_material_or_404(material_id: UUID) -> ContractMaterial:
    return get_object_or_404(
        ContractMaterial.objects.select_related("milestone__contract", "catalog_item"),
        pk=material_id,
    )


def list_materials(milestone: Milestone) -> QuerySet[ContractMaterial]:
    return milestone.materials.select_related("catalog_item").order_by("created_at")


def level(milestone: Milestone | None) -> int:
    """Глубина узла (корень = 1) — проходом вверх по `parent` (высота дерева
    ограничена MAX_TREE_DEPTH, поэтому цикл короткий и не нуждается в
    recursive CTE)."""
    depth = 0
    node = milestone
    while node is not None:
        depth += 1
        node = node.parent
    return depth


def get_timeline(milestone: Milestone, *, locale: str) -> list[contracts_selectors.TimelineEntry]:
    """GET /milestones/{id}/timeline — вне таблицы tech-spec.md §8.5, тот же
    приём, что `apps.contracts.selectors.get_timeline`/`get_amendment_
    timeline` (read-модель из outbox, `subject.type="milestone"`; полная
    лента этапа — здесь, в хронику договора уходят только ключевые точки,
    `apps.contracts.events.NESTED_TOPICS`, ADR-134). Элементы — того же
    контракта, что у договора (`contracts_selectors.timeline_entries`)."""
    rows = OutboxEvent.objects.filter(
        subject__type="milestone", subject__id=str(milestone.id)
    ).order_by("occurred_at", "event_id")
    return contracts_selectors.timeline_entries(rows, locale=locale)


def acceptance_window_status(milestone: Milestone) -> dict[str, Any]:
    """`GET /milestones/{id}/acceptance` (tech-spec.md §8.5): «дедлайн, факт
    размещения уведомлений в ЛК, часов осталось»."""
    deadline = (
        deadlines_selectors.list_active_for_subject(
            subject_type="milestone", subject_id=milestone.id
        )
        .filter(kind=_ACCEPTANCE_DEADLINE_KIND)
        .order_by("-anchor_at")
        .first()
    )
    if deadline is None:
        return {
            "placed_in_cabinet": False,
            "deadline_at": None,
            "hours_left": None,
        }
    hours_left = None
    if deadline.deadline_at is not None:
        hours_left = max((deadline.deadline_at - timezone.now()).total_seconds() / 3600, 0.0)
    return {
        "placed_in_cabinet": deadline.anchor_at is not None,
        "deadline_at": deadline.deadline_at,
        "hours_left": hours_left,
    }


def list_awaiting_acceptance_for_profiles(profile_ids: Iterable[Any]) -> QuerySet[Milestone]:
    """`apps.dashboards` (ADR-090): «требует моей приёмки» — листья
    (`children__isnull=True`, domain-model.md §7.1: принимаются только
    листья) в `status=UNDER_ACCEPTANCE` на договорах, где вызывающий —
    сторона CUSTOMER. `profile_id`/`role` — условия ОДНОГО и того же
    `ContractParty` (один вызов `.filter()`, не цепочка `.filter().filter()`
    — иначе Django join'ит два РАЗНЫХ ряда `parties` и условие перестаёт
    значить «эта же сторона», domain-model.md §6.1 join-ловушка)."""
    return (
        Milestone.objects.filter(
            status=Milestone.Status.UNDER_ACCEPTANCE,
            children__isnull=True,
            contract__parties__profile_id__in=profile_ids,
            contract__parties__role=ContractParty.Role.CUSTOMER,
        )
        .select_related("contract")
        .distinct()
    )


def list_in_progress_for_profiles(profile_ids: Iterable[Any]) -> QuerySet[Milestone]:
    """`apps.dashboards` (ADR-090): «сдача этапа с моей стороны» — листья
    `IN_PROGRESS` на договорах, где вызывающий — сторона CONTRACTOR. Тот же
    приём одного `.filter()`, что `list_awaiting_acceptance_for_profiles`."""
    return (
        Milestone.objects.filter(
            status=Milestone.Status.IN_PROGRESS,
            children__isnull=True,
            contract__parties__profile_id__in=profile_ids,
            contract__parties__role=ContractParty.Role.CONTRACTOR,
        )
        .select_related("contract")
        .distinct()
    )


def list_execution_leaves_for_profiles(profile_ids: Iterable[Any]) -> QuerySet[Milestone]:
    """`apps.dashboards` (разделы /stages и /payments, отсмотр 2026-08-22):
    ВСЕ листья договоров в исполнении (SIGNED), где вызывающий — любая
    сторона. В отличие от attention-селекторов выше, роль не фиксируется:
    раздел показывает и мои обязанности, и ожидание контрагента. Тот же
    приём одного `.filter()` (join-ловушка, domain-model.md §6.1)."""
    return (
        Milestone.objects.filter(
            children__isnull=True,
            contract__negotiation_status=Contract.NegotiationStatus.SIGNED,
            contract__parties__profile_id__in=profile_ids,
        )
        .select_related("contract")
        .order_by("contract_id", "order", "created_at")
        .distinct()
    )


def effective_sphere_id(milestone: Milestone) -> UUID | None:
    """domain-model.md §7.1 `effective_sphere`: ближайшая заданная сфера по
    цепочке родителей (мультисферность — сфера может задаваться на ветке)."""
    node: Milestone | None = milestone
    while node is not None:
        if node.sphere_id is not None:
            return node.sphere_id
        node = node.parent
    return None


_ACCEPTANCE_DECIDED_OUTCOMES = frozenset({"accepted", "rejected"})


def reputation_facts(contract: Contract) -> list[dict[str, Any]]:
    """Узкий фасад ДЛЯ БЭКФИЛЛА репутации (ADR-163 §7): по одному словарю
    на ЛИСТ дерева (принимаются и оплачиваются только листья,
    domain-model.md §7.1) с ровно теми фактами, из которых считаются оси
    сроков.

    Фасад, а не прямое чтение `Milestone` из apps.reputation: «что такое
    автоприёмка» и «где живёт окно приёмки» — знание apps.milestones, и
    второе его определение в чужом приложении разъехалось бы с первым при
    любой правке ADR-057/140. Рабочий путь карточки этим фасадом НЕ
    пользуется вовсе — он строится из событий (ADR-076); фасад нужен
    ровно затем, что старые события новых полей не несут.

    `acceptance_prompt`: `True` — заказчик принял В ОКНЕ сам; `False` —
    автоприёмка по тайм-ауту (дедлайн сработал, решения не было) либо
    приёмка после дедлайна; `None` — окно не заякорено (мерить нечего)."""
    children = children_map(contract)
    rows: list[dict[str, Any]] = []
    for milestone in list_contract_milestones(contract):
        if not is_leaf(milestone, children_map=children):
            continue
        deadline = deadlines_selectors.latest_deadline_for_subject(
            kind=_ACCEPTANCE_DEADLINE_KIND, subject_type="milestone", subject_id=milestone.id
        )
        auto_accepted = (
            deadline is not None
            and deadline.fired_at is not None
            and (deadline.outcome or "") not in _ACCEPTANCE_DECIDED_OUTCOMES
        )
        acceptance_prompt: bool | None = None
        if auto_accepted:
            acceptance_prompt = False
        elif (
            deadline is not None
            and deadline.deadline_at is not None
            and milestone.accepted_at is not None
        ):
            acceptance_prompt = milestone.accepted_at <= deadline.deadline_at
        sphere = milestone.sphere
        rows.append(
            {
                "milestone_id": milestone.id,
                "title": milestone.title,
                "sphere_code": sphere.code if sphere is not None else "",
                "due_at": milestone.deadline,
                "submitted_at": milestone.submitted_at,
                "accepted_at": milestone.accepted_at,
                "auto_accepted": auto_accepted,
                "acceptance_prompt": acceptance_prompt,
            }
        )
    return rows
