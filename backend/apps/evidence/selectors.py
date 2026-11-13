"""Read-слой apps.evidence."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from django.db.models import QuerySet
from django.shortcuts import get_object_or_404

from apps.deadlines import selectors as deadlines_selectors

from .models import Evidence, RetentionTimer

RETENTION_POLICY_KINDS: dict[str, str] = {
    "hot_days": "evidence_hot_retention",
    "archive_days": "evidence_archive_retention",
    "notice_days": "evidence_retention_notice",
    "dispute_pause_cap_days": "evidence_dispute_pause_cap",
}


def retention_policy() -> dict[str, int | bool | None]:
    """`GET /evidence/retention-policy` (ADR-137 требование 9: ограничение
    срока видно при создании сделки, а не только в уведомлении за 10 дней) —
    сроки из DeadlineKindConfig (данные), `hashes_forever` — принцип
    ADR-036/137, не настройка. Незасеянная категория — `None`, не 500."""
    policy: dict[str, int | bool | None] = {}
    for field, kind in RETENTION_POLICY_KINDS.items():
        duration = deadlines_selectors.get_kind_duration(kind)
        policy[field] = duration.days if duration is not None else None
    policy["hashes_forever"] = True
    return policy


def get_evidence_or_404(evidence_id: UUID) -> Evidence:
    return get_object_or_404(
        Evidence.objects.select_related("contract", "milestone", "dispute"), pk=evidence_id
    )


def list_for_milestone(milestone_id: UUID) -> QuerySet[Evidence]:
    return Evidence.objects.filter(milestone_id=milestone_id)


def list_for_dispute(dispute_id: UUID) -> QuerySet[Evidence]:
    return Evidence.objects.filter(dispute_id=dispute_id)


def uncovered_checklist_items(*, checklist_item_ids: list[UUID]) -> set[UUID]:
    """Какие из переданных пунктов чек-листа НЕ подтверждены ни одним
    `Evidence`. Покрытие — «есть хотя бы один файл, привязанный к пункту»
    (поэлементной сверки с типом доказательства по-прежнему нет).

    До ADR-164 здесь жил булев `required_evidence_covered`, и его ответ был
    ЖЁСТКИМ гейтом сдачи этапа. Гейт снят, поэтому наружу нужен не
    «можно/нельзя», а СПИСОК непокрытых пунктов: из него собирается мягкое
    предупреждение исполнителю в диалоге «Сдать этап» и пометка заказчику
    при приёмке."""
    if not checklist_item_ids:
        return set()
    covered_ids = set(
        Evidence.objects.filter(checklist_item_id__in=checklist_item_ids)
        .values_list("checklist_item_id", flat=True)
        .distinct()
    )
    return set(checklist_item_ids) - covered_ids


# --- ADR-139: экспорт архива сделки (apps.archive читает через фасад) -------


def list_for_contract(contract_id: UUID) -> QuerySet[Evidence]:
    """Все доказательства договора в детерминированном порядке (по id —
    uuid7 монотонен по времени) — состав `files.zip`/манифеста пакета."""
    return Evidence.objects.filter(contract_id=contract_id).order_by("id")


def get_retention_timer(contract_id: UUID) -> RetentionTimer | None:
    return RetentionTimer.objects.filter(contract_id=contract_id).first()


def retention_summary(contract_id: UUID) -> dict[str, Any]:
    """Сроки хранения договора для манифеста/превью архива: состояние
    таймера и даты дедлайнов (None — таймер ещё не стартовал: сделка идёт)."""
    timer = get_retention_timer(contract_id)
    if timer is None:
        return {"state": None, "anchored_at": None, "hot_until": None, "archive_until": None}

    def _at(deadline_id: UUID) -> str | None:
        deadline = deadlines_selectors.get_deadline(deadline_id)
        if deadline is None or deadline.deadline_at is None:
            return None
        return deadline.deadline_at.isoformat()

    return {
        "state": timer.state,
        "anchored_at": timer.anchored_at.isoformat(),
        "hot_until": _at(timer.hot_deadline_id),
        "archive_until": _at(timer.archive_deadline_id),
        "paused": timer.paused_at is not None,
    }
