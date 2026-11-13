from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from common.money import CurrencyMismatchError, Money, assert_single_currency

CURRENCIES = st.sampled_from(["RUB", "USD", "EUR"])
AMOUNTS = st.decimals(
    min_value="-1000000", max_value="1000000", places=2, allow_nan=False, allow_infinity=False
)


def money(amounts=AMOUNTS, currencies=CURRENCIES):
    return st.builds(Money, amount=amounts, currency=currencies)


@given(a=AMOUNTS, b=AMOUNTS, c=AMOUNTS, currency=CURRENCIES)
def test_addition_is_associative(a, b, c, currency):
    x, y, z = Money(a, currency), Money(b, currency), Money(c, currency)
    assert (x + y) + z == x + (y + z)


@given(a=AMOUNTS, b=AMOUNTS, currency=CURRENCIES)
def test_addition_is_commutative(a, b, currency):
    x, y = Money(a, currency), Money(b, currency)
    assert x + y == y + x


def test_forbids_adding_different_currencies():
    with pytest.raises(CurrencyMismatchError):
        Money("10.00", "RUB") + Money("10.00", "USD")


@given(a=AMOUNTS, b=AMOUNTS, currency=CURRENCIES)
def test_ordering_matches_amount_ordering(a, b, currency):
    x, y = Money(a, currency), Money(b, currency)
    assert (x < y) == (a < b)
    assert (x <= y) == (a <= b)
    assert (x > y) == (a > b)
    assert (x >= y) == (a >= b)


def test_forbids_comparing_different_currencies():
    with pytest.raises(CurrencyMismatchError):
        assert Money("10.00", "RUB") <= Money("10.00", "USD")
    with pytest.raises(CurrencyMismatchError):
        assert Money("10.00", "RUB") < Money("10.00", "USD")


def test_forbids_subtracting_different_currencies():
    with pytest.raises(CurrencyMismatchError):
        Money("10.00", "RUB") - Money("10.00", "USD")


def test_different_currency_same_amount_is_not_equal():
    assert Money("10.00", "RUB") != Money("10.00", "USD")


def test_currency_is_required():
    with pytest.raises(ValueError):
        Money("10.00", "")


def test_money_without_currency_argument_is_not_constructible():
    with pytest.raises(TypeError):
        Money("10.00")  # type: ignore[call-arg]


def test_rejects_float_amount():
    with pytest.raises(TypeError):
        Money(10.5, "RUB")


def test_assert_single_currency_returns_the_common_currency():
    monies = [Money("10.00", "RUB"), Money("5.00", "RUB"), Money("0.50", "RUB")]
    assert assert_single_currency(monies) == "RUB"


def test_assert_single_currency_rejects_mixed_currencies():
    monies = [Money("10.00", "RUB"), Money("5.00", "USD")]
    with pytest.raises(CurrencyMismatchError):
        assert_single_currency(monies)


def test_assert_single_currency_rejects_empty_collection():
    with pytest.raises(ValueError):
        assert_single_currency([])


@given(amounts=st.lists(AMOUNTS, min_size=1, max_size=20), currency=CURRENCIES)
def test_sum_builtin_works_via_radd(amounts, currency):
    monies = [Money(a, currency) for a in amounts]
    expected = Money("0.00", currency)
    for m in monies:
        expected = expected + m
    assert sum(monies) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("10", Decimal("10.00")),
        ("10.005", Decimal("10.01")),  # ROUND_HALF_UP
        ("10.004", Decimal("10.00")),
        ("10.1", Decimal("10.10")),
    ],
)
def test_rounds_to_two_decimal_places(raw, expected):
    assert Money(raw, "RUB").amount == expected
