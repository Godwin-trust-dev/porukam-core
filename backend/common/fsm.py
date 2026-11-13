"""Лёгкий FSM-механизм: декларация переходов + проверка допустимости.

Свой, вместо django-fsm-2 ([Т-решение] допускается tech-spec.md) — см. ADR
в docs/adr/. `StateMachine` не хранит состояние сущности и не выполняет
side-effects: он только объявляет граф допустимых переходов. Поле состояния
живёт в models.py, а вызов перехода и side-effects — в services.py (никаких
Django-сигналов для бизнес-логики, CLAUDE.md).
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass


class InvalidTransitionError(ValueError):
    """Переход запрещён машиной состояний из текущего состояния."""


@dataclass(frozen=True, slots=True)
class Transition:
    name: str
    source: str
    target: str


class StateMachine:
    """Декларативный граф переходов. Один экземпляр на тип сущности."""

    def __init__(self, states: Iterable[str], transitions: Iterable[Transition]) -> None:
        self.states = frozenset(states)
        self._transitions = tuple(transitions)
        self._by_name_and_source: dict[tuple[str, str], Transition] = {}
        for t in self._transitions:
            if t.source not in self.states:
                raise ValueError(f"переход {t.name!r}: неизвестное исходное состояние {t.source!r}")
            if t.target not in self.states:
                raise ValueError(f"переход {t.name!r}: неизвестное целевое состояние {t.target!r}")
            key = (t.name, t.source)
            if key in self._by_name_and_source:
                raise ValueError(f"дублирующийся переход {t.name!r} из состояния {t.source!r}")
            self._by_name_and_source[key] = t

    def allowed_transitions(self, source: str) -> list[Transition]:
        """Все переходы, допустимые из состояния `source`."""
        return [t for t in self._transitions if t.source == source]

    def can_transition(self, name: str, source: str) -> bool:
        return (name, source) in self._by_name_and_source

    def assert_transition(self, name: str, source: str) -> Transition:
        """Проверяет допустимость перехода `name` из `source`.

        Возвращает Transition с целевым состоянием — services.py присваивает
        его полю состояния модели внутри своей транзакции. Бросает
        InvalidTransitionError, если переход недопустим (это и есть «каждый
        запрет — отдельным тестом» из CLAUDE.md: несуществующий переход,
        переход из неверного состояния — всё сюда).
        """
        try:
            return self._by_name_and_source[(name, source)]
        except KeyError as exc:
            raise InvalidTransitionError(
                f"переход {name!r} недопустим из состояния {source!r}"
            ) from exc
