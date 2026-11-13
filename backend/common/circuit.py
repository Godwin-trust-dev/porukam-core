"""Заготовка под circuit breaker внешних провайдеров (tech-spec.md §9.3;
docs/tasks/fundament-2.md ЭФ.6 п.2: "статусы фейк-провайдеров"). Полноценный
breaker (открытие по порогу ошибок, half-open пробы) — задача момента, когда
появятся РЕАЛЬНЫЕ провайдеры (сейчас — только фейки из §9.1, которые не
падают сами по себе); здесь — только реестр состояний + счётчики, чтобы
метрика и место подключения уже существовали (common/metrics.py:
ProviderCircuitCollector читает `states()` при каждом /metrics-скрейпе).

Состояние — в памяти процесса (module-level dict), НЕ в Redis/БД: это
заготовка на один процесс, не распределённый breaker — go на реальный
breaker перепишет хранение состояния, не публичный API record_success/
record_failure ниже (потребители — providers.py фейков — не изменятся).
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, replace

CLOSED = "closed"
OPEN = "open"


@dataclass
class _ProviderState:
    state: str = CLOSED
    successes: int = 0
    failures: int = 0


_lock = threading.Lock()
_states: dict[str, _ProviderState] = {}


def record_success(provider: str) -> None:
    with _lock:
        state = _states.setdefault(provider, _ProviderState())
        state.successes += 1
        state.state = CLOSED


def record_failure(provider: str) -> None:
    with _lock:
        state = _states.setdefault(provider, _ProviderState())
        state.failures += 1
        # Заглушка порога: сама заготовка не открывает breaker (нет реальных
        # сбоев у фейков) — состояние management вручную/будущим кодом.


def states() -> dict[str, _ProviderState]:
    with _lock:
        return {provider: replace(s) for provider, s in _states.items()}


def _reset_for_tests() -> None:
    with _lock:
        _states.clear()
