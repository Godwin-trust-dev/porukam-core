"""Money — value object: сумма + валюта.

Обязательный инвариант (CLAUDE.md): деньги — всегда пара (amount: Decimal,
currency); валюты по умолчанию нет нигде. Складывать/сравнивать можно только
одинаковые валюты — иначе `CurrencyMismatchError`.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

_QUANTIZE = Decimal("0.01")

MoneyAmount = Decimal | int | str


class CurrencyMismatchError(ValueError):
    """Попытка сложить или сравнить Money разных валют."""


def _to_decimal(amount: MoneyAmount) -> Decimal:
    if isinstance(amount, float):
        raise TypeError(
            "Money не принимает float — используйте Decimal или str, иначе теряется точность"
        )
    value = amount if isinstance(amount, Decimal) else Decimal(amount)
    return value.quantize(_QUANTIZE, rounding=ROUND_HALF_UP)


@dataclass(frozen=True, slots=True)
class Money:
    amount: Decimal
    currency: str

    def __init__(self, amount: MoneyAmount, currency: str) -> None:
        if not currency:
            raise ValueError("currency обязательна: валюты по умолчанию нет")
        object.__setattr__(self, "amount", _to_decimal(amount))
        object.__setattr__(self, "currency", currency)

    def _require_same_currency(self, other: Money) -> None:
        if self.currency != other.currency:
            raise CurrencyMismatchError(f"нельзя смешивать {self.currency} и {other.currency}")

    def __add__(self, other: Money) -> Money:
        if not isinstance(other, Money):
            return NotImplemented
        self._require_same_currency(other)
        return Money(self.amount + other.amount, self.currency)

    def __radd__(self, other: int) -> Money:
        # позволяет sum([Money(...), Money(...)]) — sum() стартует с int 0.
        if other == 0:
            return self
        return NotImplemented

    def __sub__(self, other: Money) -> Money:
        if not isinstance(other, Money):
            return NotImplemented
        self._require_same_currency(other)
        return Money(self.amount - other.amount, self.currency)

    def __str__(self) -> str:
        return f"{self.amount} {self.currency}"

    def __lt__(self, other: Money) -> bool:
        if not isinstance(other, Money):
            return NotImplemented
        self._require_same_currency(other)
        return self.amount < other.amount

    def __le__(self, other: Money) -> bool:
        if not isinstance(other, Money):
            return NotImplemented
        self._require_same_currency(other)
        return self.amount <= other.amount

    def __gt__(self, other: Money) -> bool:
        if not isinstance(other, Money):
            return NotImplemented
        self._require_same_currency(other)
        return self.amount > other.amount

    def __ge__(self, other: Money) -> bool:
        if not isinstance(other, Money):
            return NotImplemented
        self._require_same_currency(other)
        return self.amount >= other.amount


def assert_single_currency(monies: Iterable[Money]) -> str:
    """Один договор — одна валюта (tech-spec.md §5.2.5, концепция §46).

    Проверяет, что все Money в коллекции одной валюты, и возвращает её.
    Пустая коллекция — ValueError (валюту определить не из чего).
    """
    codes = {m.currency for m in monies}
    if not codes:
        raise ValueError("нечего проверять: пустая коллекция Money")
    if len(codes) > 1:
        raise CurrencyMismatchError(f"смешаны валюты: {sorted(codes)}")
    return codes.pop()
