"""Интерфейс провайдера строгой идентификации (tech-spec.md §9.1, ADR-052)
+ фейк-ЕСИА (CLAUDE.md: «внешние провайдеры — только интерфейсы + фейки»;
реальной интеграции с ЕСИА нет и не планируется в рамках 3.2).

services.py не оперирует понятием «ЕСИА» напрямую — только протоколом
IdentityVerificationProvider и строковым provider_code; конкретный
провайдер — деталь этого модуля (ADR-062).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


class IdentityProviderError(Exception):
    """Базовая ошибка провайдера строгой идентификации."""


class InvalidVerificationCodeError(IdentityProviderError):
    """Код авторизации не распознан или просрочен провайдером."""


@dataclass(frozen=True, slots=True)
class VerifiedIdentity:
    full_name: str
    tax_id: str
    attributes: dict[str, Any]


class IdentityVerificationProvider(Protocol):
    provider_code: str

    def authorize_url(self, *, state: str, code_challenge: str) -> str: ...

    def complete(self, *, code: str) -> VerifiedIdentity: ...


class FakeEsiaProvider:
    """Полностью детерминированный фейк: код авторизации сам кодирует
    "ФИО|ИНН" — тесты управляют результатом верификации напрямую, не
    полагаясь на внешний сервис."""

    provider_code = "esia_fake"

    def authorize_url(self, *, state: str, code_challenge: str) -> str:
        return (
            "https://esia.gosuslugi.ru/aas/oauth2/ac"
            f"?response_type=code&state={state}"
            f"&code_challenge={code_challenge}&code_challenge_method=S256"
        )

    def complete(self, *, code: str) -> VerifiedIdentity:
        parts = code.split("|")
        if len(parts) != 2 or not all(parts):
            raise InvalidVerificationCodeError(f"нераспознанный код ЕСИА: {code!r}")
        full_name, tax_id = parts
        return VerifiedIdentity(full_name=full_name, tax_id=tax_id, attributes={"tax_id": tax_id})
