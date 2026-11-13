"""Интерфейс провайдера реестра юрлиц (tech-spec.md §5.2.2, §8.2) + фейк
ЕГРЮЛ/ЕГРИП (CLAUDE.md: «внешние провайдеры — только интерфейсы + фейки»;
реальной интеграции с ФНС нет и не планируется в рамках 3.4).

services.py не оперирует понятием «ЕГРЮЛ» напрямую — только протоколом
EntityRegistryProvider; конкретный провайдер — деталь этого модуля.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any, ClassVar, Protocol


@dataclass(frozen=True, slots=True)
class RegistryTaxIdentifier:
    id_type: str
    value: str


@dataclass(frozen=True, slots=True)
class RegistryEntityData:
    """Карточка компании из государственного реестра (domain-model.md
    §3.2.1). `found=False` — идентификатор реестру неизвестен."""

    found: bool
    name: str = ""
    short_name: str = ""
    local_form_code: str = ""
    tax_identifiers: tuple[RegistryTaxIdentifier, ...] = ()
    registered_address: dict[str, Any] = field(default_factory=dict)
    director_full_name: str = ""
    director_position_label: str = ""
    director_since: date | None = None
    is_active_in_registry: bool = True


class EntityRegistryProvider(Protocol):
    provider_code: str

    def fetch_entity_data(self, tax_id: str) -> RegistryEntityData: ...


class FakeEntityRegistryProvider:
    """Полностью детерминированный фейк ЕГРЮЛ/ЕГРИП: 4 канонические карточки
    (ООО с директором, ИП, самозанятый, ликвидированная) — по одному
    закреплённому ИНН на сценарий (etap-3.md 3.4: «детерминированные
    карточки»). Тесты, которым нужны другие ФИО/ИНН, передают `records` в
    конструктор — не полагаясь на монипатчинг глобального состояния."""

    provider_code = "entity_registry_fake"

    LLC_WITH_DIRECTOR_INN = "7701111111"
    SOLE_PROPRIETOR_INN = "500100732259"
    SELF_EMPLOYED_INN = "770100000001"
    LIQUIDATED_INN = "9998887766"

    _DEFAULT_RECORDS: ClassVar[dict[str, RegistryEntityData]] = {
        LLC_WITH_DIRECTOR_INN: RegistryEntityData(
            found=True,
            name='ООО "Ромашка"',
            short_name="Ромашка",
            local_form_code="ru_ooo",
            tax_identifiers=(RegistryTaxIdentifier("inn", LLC_WITH_DIRECTOR_INN),),
            registered_address={"city": "Москва"},
            director_full_name="Иван Петрович Директоров",
            director_position_label="Генеральный директор",
            director_since=date(2020, 1, 15),
            is_active_in_registry=True,
        ),
        SOLE_PROPRIETOR_INN: RegistryEntityData(
            found=True,
            name="ИП Кузнецов Пётр Сергеевич",
            local_form_code="ru_ip",
            tax_identifiers=(RegistryTaxIdentifier("inn", SOLE_PROPRIETOR_INN),),
            registered_address={"city": "Казань"},
            is_active_in_registry=True,
        ),
        SELF_EMPLOYED_INN: RegistryEntityData(
            found=True,
            name="Самозанятый Смирнова Анна Викторовна",
            local_form_code="ru_self_employed",
            tax_identifiers=(RegistryTaxIdentifier("inn", SELF_EMPLOYED_INN),),
            registered_address={"city": "Новосибирск"},
            is_active_in_registry=True,
        ),
        LIQUIDATED_INN: RegistryEntityData(
            found=True,
            name='ООО "Закат"',
            local_form_code="ru_ooo",
            tax_identifiers=(RegistryTaxIdentifier("inn", LIQUIDATED_INN),),
            registered_address={"city": "Пермь"},
            director_full_name="Ликвидатор Ликвидаторов",
            is_active_in_registry=False,
        ),
    }

    def __init__(self, records: dict[str, RegistryEntityData] | None = None) -> None:
        self._records = {**self._DEFAULT_RECORDS, **(records or {})}

    def fetch_entity_data(self, tax_id: str) -> RegistryEntityData:
        return self._records.get(tax_id, RegistryEntityData(found=False))
