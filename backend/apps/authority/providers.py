"""Интерфейс реестра МЧД (машиночитаемых доверенностей) + фейк
(CLAUDE.md: «внешние провайдеры — только интерфейсы + фейки»; реальной
интеграции с ФНС МЧД нет и не планируется в рамках 3.5).

`SigningAuthority.is_valid_now()` перепроверяет по этому провайдеру ПРИ
КАЖДОМ подписании для оснований `notarized_poa`/`chained_delegation`
(domain-model.md §4) — доверенность могла быть отозвана после выдачи права
подписи на платформе."""

from __future__ import annotations

from typing import ClassVar, Protocol


class PoaRegistryProvider(Protocol):
    provider_code: str

    def check_poa_active(self, poa_registry_id: str) -> bool: ...


class FakePoaRegistryProvider:
    """Детерминированный фейк: доверенность активна, если её id не входит в
    явно переданный список отозванных (по умолчанию — id с префиксом
    "revoked-" считаются отозванными, остальные — активны)."""

    provider_code = "poa_registry_fake"

    REVOKED_PREFIX: ClassVar[str] = "revoked-"

    def __init__(self, revoked_ids: frozenset[str] = frozenset()) -> None:
        self._revoked_ids = revoked_ids

    def check_poa_active(self, poa_registry_id: str) -> bool:
        if poa_registry_id in self._revoked_ids:
            return False
        return not poa_registry_id.startswith(self.REVOKED_PREFIX)


# Тот же приём, что DEFAULT_TIMESTAMP_PROVIDER (common.timestamps): модульный
# дефолт + инъекция параметром в сервисах (ADR-096).
DEFAULT_POA_PROVIDER = FakePoaRegistryProvider()
