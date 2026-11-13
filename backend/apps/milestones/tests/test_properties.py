"""etap-4.md Э4.3: property-based тесты (Hypothesis) дерева этапов —
инвариант сумм при любой структуре, запрет глубины 7 (см. также
apps/deadlines/tests/test_properties.py — тот же приём: `max_examples`
небольшой + `deadline=None` + `suppress_health_check` для БД-теста)."""

from __future__ import annotations

import itertools
from decimal import Decimal

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from apps.contracts.models import Contract
from apps.milestones import services
from apps.milestones.models import MAX_TREE_DEPTH

from ._helpers import make_contract, make_user

pytestmark = pytest.mark.django_db

_LEAF = "leaf"


def _tree_shape(remaining_depth: int):
    """Форма дерева: "leaf" либо список дочерних форм. `remaining_depth` —
    сколько уровней ещё можно вложить (корень вызывается с MAX_TREE_DEPTH),
    так что сгенерированная форма всегда укладывается в лимит глубины."""
    if remaining_depth <= 1:
        return st.just(_LEAF)
    return st.one_of(
        st.just(_LEAF),
        st.lists(_tree_shape(remaining_depth - 1), min_size=1, max_size=2),
    )


_FOREST = st.lists(_tree_shape(MAX_TREE_DEPTH), min_size=1, max_size=2)
_seq = itertools.count(1)


def _fresh_contract() -> Contract:
    """Свежий договор на каждый пример Hypothesis (иначе деревья/пользователи
    накапливались бы между примерами одного прогона теста)."""
    customer = make_user(f"h{next(_seq)}")
    contractor = make_user(f"h{next(_seq)}")
    return make_contract(customer=customer, contractor=contractor)


def _count_leaves(shape) -> int:
    if shape == _LEAF:
        return 1
    return sum(_count_leaves(child) for child in shape)


def _build(shape, *, contract, user, parent, amounts_iter):
    if shape == _LEAF:
        return services.create_milestone(
            contract,
            user=user,
            title="leaf",
            parent=parent,
            amount=next(amounts_iter),
            currency="RUB",
        )
    branch = services.create_milestone(contract, user=user, title="branch", parent=parent)
    for child_shape in shape:
        _build(child_shape, contract=contract, user=user, parent=branch, amounts_iter=amounts_iter)
    return branch


@given(forest=_FOREST, data=st.data())
@settings(
    max_examples=20,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.too_slow],
)
def test_leaf_sum_invariant_holds_for_any_tree_structure(forest, data):
    """Инвариант сумм: сумма листьев дерева (build_tree/total_leaf_amount)
    равна сумме случайно сгенерированных amount'ов листьев — при ЛЮБОЙ форме
    дерева (случайное ветвление, случайная глубина ≤ MAX_TREE_DEPTH)."""
    leaf_count = sum(_count_leaves(shape) for shape in forest)
    amounts = data.draw(
        st.lists(
            st.decimals(min_value=Decimal("0.01"), max_value=Decimal("999.99"), places=2),
            min_size=leaf_count,
            max_size=leaf_count,
        )
    )
    contract = _fresh_contract()
    customer = contract.created_by

    amounts_iter = iter(amounts)
    for shape in forest:
        _build(shape, contract=contract, user=customer, parent=None, amounts_iter=amounts_iter)

    total = services.total_leaf_amount(contract)
    assert total.amount == sum(amounts, start=Decimal("0"))
    assert total.currency == "RUB"


@given(
    titles=st.lists(
        st.text(min_size=1, max_size=20, alphabet=st.characters(exclude_categories=("Cs", "Cc"))),
        min_size=MAX_TREE_DEPTH,
        max_size=MAX_TREE_DEPTH,
    )
)
@settings(
    max_examples=15,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.too_slow],
)
def test_depth_7_is_always_forbidden_regardless_of_titles(titles):
    """Запрет глубины 7: для ЛЮБЫХ (случайных) заголовков цепочка из
    MAX_TREE_DEPTH веток всегда даёт возможность построить 7-й уровень
    только с ошибкой — инвариант не зависит от конкретных данных узлов."""
    contract = _fresh_contract()
    customer = contract.created_by

    node = None
    for title in titles:
        node = services.create_milestone(contract, user=customer, title=title, parent=node)
    with pytest.raises(services.MilestoneDepthExceededError):
        services.create_milestone(contract, user=customer, title="overflow", parent=node)
