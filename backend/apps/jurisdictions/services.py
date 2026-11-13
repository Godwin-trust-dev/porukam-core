"""Use cases apps.jurisdictions."""

from __future__ import annotations

from .models import JurisdictionConfig


class CurrencyNotAllowedError(ValueError):
    """Валюта не входит в allowed_currency_codes юрисдикции."""


def assert_currency_allowed(jurisdiction: JurisdictionConfig, currency_code: str) -> None:
    """Валюта договора входит в allowed_currency_codes юрисдикции
    (tech-spec.md §5.2.5 ревизия 2.0.3, концепция §46).

    default_currency_code здесь не участвует ни как дефолт, ни как fallback
    (ADR-041) — проверяется только код, явно полученный от клиента API.
    """
    if currency_code not in jurisdiction.allowed_currency_codes:
        raise CurrencyNotAllowedError(
            f"валюта {currency_code!r} не допущена в юрисдикции {jurisdiction.country_code!r}"
        )
