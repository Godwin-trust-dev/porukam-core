"""Единственный use case записи в этом read-only приложении (CLAUDE.md:
`dashboards` — только `selectors` поверх остальных читает чужие данные, но
запись метрики каталожного поиска — не бизнес-логика продукта, а
наблюдаемость, и она вынесена сюда из вьюхи по той же причине, что и любой
другой use case: вьюха не решает, что и когда писать, — CLAUDE.md §2.4).

Единственный вызов — в `apps.analytics` (ADR-186): обычный вызов facade'а
одного приложения из другого, тем же способом, каким приложения вообще
общаются друг с другом (CLAUDE.md: «через services.py-фасады»). Это НЕ
нарушение правила «аналитика — читатель, а не участник» (ADR-145) — то
правило запрещает `apps.analytics` импортировать чужое, а не чужим
приложениям писать в неё через её собственный интерфейс.
"""

from __future__ import annotations

import logging
from typing import Any

from apps.analytics import services as analytics_services

logger = logging.getLogger(__name__)


def record_catalog_search_metric(
    *, user_id: Any | None, geo_level: str, has_sphere: bool, has_experience: bool
) -> None:
    """Пишет факт каталожного поиска в аналитику (ADR-186, часть 7 плана
    11.09). Отказ аналитики (например, недоступный кеш дедупликации) не
    должен ронять поиск пользователю — перехватываем и логируем, но не
    пробрасываем дальше."""
    try:
        analytics_services.record_catalog_search(
            user_id=user_id,
            geo_level=geo_level,
            has_sphere=has_sphere,
            has_experience=has_experience,
        )
    except Exception:  # noqa: BLE001 — метрика не должна ронять поиск
        logger.exception("dashboards: не удалось записать метрику каталожного поиска")
