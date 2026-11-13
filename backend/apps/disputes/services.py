"""Use cases apps.disputes — этап 7 (docs/plan.md «Этап 7. Споры и гарантия»,
ADR-131). Поверх заглушки Э4.6: два раунда исправлений, скидка допником,
окна оспаривания (ADR-019), потолок 30 дней (ADR-020), гарантийные
разногласия.

Направления зависимостей (import-linter, pyproject.toml):
- apps.disputes -> apps.contracts (services/selectors) — ЗАКОННО, запрещено
  только обратное («contracts не импортирует payments/disputes»);
- apps.disputes -> apps.milestones.MODELS — законно, но apps.disputes
  НИКОГДА не вызывает `apps.milestones.services`: любое действие над этапом
  (вернуть в приёмку после исправления, принять по исходу спора) едет через
  outbox (`dispute.fix_resubmitted`, `dispute.resolved`) и подписчиков
  `apps.milestones.handlers`. Прямой вызов протащил бы транзитивный запрет
  apps.contracts -> apps.milestones -> apps.disputes (докстринг
  `apps.milestones.services.reject_milestone`);
- открытие спора при отклонении приёмки — тоже подписчик
  (`handlers.handle_milestone_rejected`), не вызов из milestones.

Дедлайны (потолок спора, окна) — строки `apps.deadlines.DomainDeadline` +
свип раз в минуту (CLAUDE.md), НЕ отложенные Celery-задачи. Окна якорятся
размещением уведомления в ЛК (ADR-057, `starts_from=cabinet_placement`)."""

from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID

from django.db import transaction
from django.utils import timezone

from apps.accounts.models import User
from apps.contracts import selectors as contracts_selectors
from apps.contracts import services as contracts_services
from apps.contracts.models import Amendment, Contract, ContractParty
from apps.deadlines import selectors as deadlines_selectors
from apps.deadlines import services as deadlines_services
from apps.milestones.models import ChecklistItem, Milestone
from common import outbox
from common.fsm import InvalidTransitionError, StateMachine, Transition

from .models import (
    MAX_FIX_ROUNDS,
    DiscountAgreement,
    Dispute,
    DisputeReply,
    DisputeWindow,
    FixRequest,
)

_ROLE = ContractParty.Role
_STATUS = Dispute.Status
_OUTCOME = Dispute.Outcome
_WINDOW_KIND = DisputeWindow.Kind

# Категории дедлайнов (длительности — данные, `DeadlineKindConfig`, а не
# константы кода: tech-spec.md §11 п.4 «таблица категорий с юристом»).
_DISPUTE_CAP_KIND = "dispute_cap"
_DISPUTE_RESPONSE_WINDOW_KIND = "dispute_response_window"
_TERMINATION_WINDOW_KIND = "termination_dispute_window"

_WINDOW_DEADLINE_KIND: dict[str, str] = {
    _WINDOW_KIND.DISPUTE_RESPONSE: _DISPUTE_RESPONSE_WINDOW_KIND,
    _WINDOW_KIND.TERMINATION_NOTICE: _TERMINATION_WINDOW_KIND,
}

# Детальный код исхода -> грубая классификация tech-spec.md §5.2.7
# (`outcome text CHECK (in resolved|cap_reached|escalated_to_court)`).
# Ключи читают ещё и `apps.milestones.handlers` (какие исходы возвращают
# этап в `accepted`) и `apps.reputation.subscriber`, поэтому сузить
# `resolution_type` до трёх значений спеки нельзя — отсюда таблица
# соответствия, а не одно поле.
RESOLUTION_OUTCOME: dict[str, str] = {
    "accepted": _OUTCOME.RESOLVED,
    "withdrawn": _OUTCOME.RESOLVED,
    "discount_accepted": _OUTCOME.RESOLVED,
    "warranty_satisfied": _OUTCOME.RESOLVED,
    "warranty_declined": _OUTCOME.RESOLVED,
    "cap_reached": _OUTCOME.CAP_REACHED,
    "escalated_to_court": _OUTCOME.ESCALATED_TO_COURT,
}

# Гарантийные исходы и сторона, которой они доступны (ADR-131 доп. 26.08,
# ADR-133): претензию подаёт заказчик, отказывает по ней исполнитель,
# подтверждает устранение заказчик.
_WARRANTY_RESOLUTION_ROLE: dict[str, str] = {
    "warranty_declined": _ROLE.CONTRACTOR,
    "warranty_satisfied": _ROLE.CUSTOMER,
}

# FSM спора (CLAUDE.md: каждый переход и каждый запрет — отдельным тестом).
# `resolve` объявлен из ВСЕХ незакрытых состояний, потому что потолок 30
# дней (ADR-020) и согласие сторон могут прийти в любой момент диалога —
# и НЕ объявлен из `resolved` (повторное закрытие — 409).
DISPUTE_FSM = StateMachine(
    states=[s.value for s in _STATUS],
    transitions=[
        Transition("request_fix", _STATUS.OPEN, _STATUS.AWAITING_FIX),
        Transition("resubmit_fix", _STATUS.AWAITING_FIX, _STATUS.OPEN),
        Transition("propose_discount", _STATUS.OPEN, _STATUS.AWAITING_DISCOUNT),
        Transition("propose_discount", _STATUS.AWAITING_FIX, _STATUS.AWAITING_DISCOUNT),
        Transition("decline_discount", _STATUS.AWAITING_DISCOUNT, _STATUS.OPEN),
        Transition("resolve", _STATUS.OPEN, _STATUS.RESOLVED),
        Transition("resolve", _STATUS.AWAITING_FIX, _STATUS.RESOLVED),
        Transition("resolve", _STATUS.AWAITING_DISCOUNT, _STATUS.RESOLVED),
    ],
)


class InvalidDisputeTransitionError(ValueError):
    """Обёртка `common.fsm.InvalidTransitionError` для DISPUTE_FSM — api/
    должен уметь отличить её от чужих FSM по типу (`_SERVICE_ERROR_STATUS`),
    тот же приём, что `InvalidExecutionTransitionError` в apps.contracts."""


class ChecklistItemNotOnMilestoneError(ValueError):
    """`checklist_item.milestone_id != milestone.id` — можно оспорить только
    пункт ЭТОГО этапа (ADR-017)."""


class EvidenceRequiredError(ValueError):
    """Отклонение без доказательства не даёт спор (ADR-017: «Нет пункта ->
    нечего оспаривать»; симметрично — нет доказательства, нечего
    рассматривать)."""


class DisputeAlreadyResolvedError(ValueError):
    """Действие над уже закрытым спором (`409 dispute_already_resolved`)."""


class FixRoundsExhaustedError(ValueError):
    """tech-spec.md §8.8: `409 fix_rounds_exhausted` — два раунда исправлений
    исчерпаны, дальше только скидка-допник, закрытие по согласию, потолок
    30 дней или суд."""


class FixRequestAlreadyResubmittedError(ValueError):
    """Повторная сдача того же раунда исправления."""


class NotDisputeCounterpartyError(ValueError):
    """Действие доступно только ВТОРОЙ стороне (ответ на разногласие,
    отклонение чужого предложения скидки)."""


class WrongDisputeSideError(ValueError):
    """Роль стороны не та, что требует действие: раунд исправления просит
    заказчик, сдаёт исполнитель."""


class DiscountNotApplicableError(ValueError):
    """Скидка меняет сумму ЛИСТА — у гарантийного спора этапа нет
    (`kind=warranty`), а сумма скидки обязана быть меньше текущей и в той же
    валюте."""


class DiscountAlreadyDecidedError(ValueError):
    """Предложение скидки уже принято или отклонено."""


class WarrantyPeriodNotActiveError(ValueError):
    """Гарантийная претензия — только пока договор в `warranty` (ADR-029):
    до завершения работ гарантии ещё нет, после `closed` — уже нет."""


class WindowAlreadyClosedError(ValueError):
    """Окно оспаривания уже закрыто (истекло, оспорено или снято)."""


def _assert_transition(name: str, dispute: Dispute) -> Transition:
    if dispute.status == _STATUS.RESOLVED:
        raise DisputeAlreadyResolvedError(f"спор {dispute.id} уже закрыт")
    try:
        return DISPUTE_FSM.assert_transition(name, dispute.status)
    except InvalidTransitionError as exc:
        raise InvalidDisputeTransitionError(str(exc)) from exc


def _party_role(dispute: Dispute, user: User) -> str:
    """Роль пользователя в договоре спора; `NotAPartyError` (apps.contracts)
    — если он вообще не сторона."""
    party = contracts_services.get_party_for_user(dispute.contract, user)
    return str(party.role)


def _event_payload(dispute: Dispute, **extra: Any) -> dict[str, Any]:
    """Самодостаточный payload (док 31 §7, ADR-098): договор, этап, обе
    стороны, метка времени — источник и для репутационной карточки (ГВ.4,
    строится ИСКЛЮЧИТЕЛЬНО из событий outbox), и для текстов уведомлений."""
    milestone = dispute.milestone
    sphere = milestone.sphere if milestone is not None else None
    payload: dict[str, Any] = {
        "dispute_id": str(dispute.id),
        "dispute_kind": dispute.kind,
        "contract_id": str(dispute.contract_id),
        "milestone_id": str(milestone.id) if milestone is not None else None,
        "milestone_title": milestone.title if milestone is not None else None,
        "milestone_sphere_code": sphere.code if sphere is not None else None,
        "checklist_item_id": (
            str(dispute.checklist_item_id) if dispute.checklist_item_id else None
        ),
        "fix_rounds_used": dispute.fix_rounds_used,
        "parties": contracts_selectors.party_identity_snapshot(dispute.contract),
        "occurred_at": timezone.now().isoformat(),
    }
    payload.update(extra)
    return payload


def _subject(dispute: Dispute) -> dict[str, str]:
    """`subject.contract_id` рядом с собственным id — так подписчик
    уведомлений (ADR-126 `_event_contract_id`) находит стороны договора."""
    return {
        "type": "dispute",
        "id": str(dispute.id),
        "contract_id": str(dispute.contract_id),
    }


def _publish(topic: str, dispute: Dispute, *, user: User | None, **extra: Any) -> None:
    outbox.publish(
        topic,
        subject=_subject(dispute),
        payload=_event_payload(dispute, **extra),
        actor={"user_id": str(user.id)} if user is not None else {},
    )


# --- Окна оспаривания (ADR-019, tech-spec.md §5.2.7 dispute_window) --------


def open_window(
    *,
    kind: str,
    contract: Contract,
    dispute: Dispute | None,
    subject_type: str,
    subject_id: UUID,
) -> DisputeWindow:
    """Открыть окно оспаривания одностороннего утверждения (ADR-019).

    Дедлайн создаётся НЕЗАЯКОРЕННЫМ (`starts_from=cabinet_placement`) — он
    начинает тикать в момент РАЗМЕЩЕНИЯ уведомления в ЛК (ADR-057:
    `apps.notifications.services._anchor_related_deadlines` якорит все
    незаякоренные дедлайны того же субъекта). Поэтому `subject_type`/
    `subject_id` дедлайна совпадают с субъектом СОБЫТИЯ, по которому уйдёт
    уведомление (`dispute` для окна ответа, `contract` для расторжения), а
    не с самим окном: иначе якорить было бы нечем и окно никогда не
    начиналось бы."""
    deadline = deadlines_services.create_deadline(
        kind=_WINDOW_DEADLINE_KIND[kind],
        subject_type=subject_type,
        subject_id=subject_id,
        starts_from="cabinet_placement",
    )
    return DisputeWindow.objects.create(
        kind=kind,
        contract=contract,
        dispute=dispute,
        subject_ref={"type": subject_type, "id": str(subject_id)},
        deadline_id=deadline.id,
    )


def sync_window_deadline(window: DisputeWindow) -> DisputeWindow:
    """Подтягивает `deadline_at`, проставленный якорением (ADR-057) уже ПОСЛЕ
    создания окна — денормализация ради чтения (`GET /dispute-windows` не
    ходит в чужую таблицу за каждой строкой)."""
    if window.deadline_at is not None or window.deadline_id is None:
        return window
    deadline = deadlines_selectors.get_deadline(window.deadline_id)
    if deadline is not None and deadline.deadline_at is not None:
        window.deadline_at = deadline.deadline_at
        window.save(update_fields=["deadline_at"])
    return window


def _close_window(
    window: DisputeWindow, *, contested: bool | None, user: User | None
) -> DisputeWindow:
    if window.closed_at is not None:
        raise WindowAlreadyClosedError(f"окно {window.id} уже закрыто")
    now = timezone.now()
    window.contested = contested
    window.closed_at = now
    fields = ["contested", "closed_at"]
    if contested is True:
        window.contested_by = user
        window.contested_at = now
        fields += ["contested_by", "contested_at"]
    window.save(update_fields=fields)
    # Свип не должен «дострелить» уже закрытое окно: пауза — штатный способ
    # снять строку с выборки (`apps.deadlines.tasks.sweep_domain_deadlines`
    # фильтрует `paused=False`); удаления дедлайнов в проекте нет.
    if window.deadline_id is not None:
        deadline = deadlines_selectors.get_deadline(window.deadline_id)
        if deadline is not None and deadline.fired_at is None:
            deadlines_services.pause_deadline(deadline, reason="dispute_window_closed")
    return window


def _publish_window_event(
    topic: str, window: DisputeWindow, *, user: User | None, **extra: Any
) -> None:
    payload: dict[str, Any] = {
        "window_id": str(window.id),
        "window_kind": window.kind,
        "contract_id": str(window.contract_id),
        "dispute_id": str(window.dispute_id) if window.dispute_id else None,
        "contested": window.contested,
        "subject_ref": window.subject_ref,
        "occurred_at": timezone.now().isoformat(),
    }
    payload.update(extra)
    outbox.publish(
        topic,
        subject={
            "type": "dispute_window",
            "id": str(window.id),
            "contract_id": str(window.contract_id),
        },
        payload=payload,
        actor={"user_id": str(user.id)} if user is not None else {},
    )


@transaction.atomic
def expire_window(window: DisputeWindow) -> DisputeWindow:
    """Свип: окно истекло без возражений (ADR-019 «не оспорено в срок ->
    ФАКТ ЗАФИКСИРОВАН»). Именно фиксация факта, а не санкция: спор от этого
    не закрывается и этап никуда не переходит — событие уходит обеим
    сторонам, дальше диалог / потолок / суд."""
    window = _close_window(window, contested=False, user=None)
    _publish_window_event("dispute.window_expired", window, user=None)
    return window


@transaction.atomic
def contest_window(window: DisputeWindow, *, user: User, comment: str = "") -> DisputeWindow:
    """`POST /dispute-windows/{id}/contest` — сторона возразила в срок
    (ADR-019: «оспорено -> автоматических последствий НЕТ, событие уходит в
    диалог»). Основной потребитель — окно оспаривания РАСТОРЖЕНИЯ исполнителем
    (ADR-028): у него, в отличие от окна ответа по спору, своей реплики нет.

    Возразить может любая сторона договора КРОМЕ инициатора утверждения; для
    окна расторжения инициатор — тот, кто расторг, и он не сторона окна."""
    contracts_services.get_party_for_user(window.contract, user)
    window = _close_window(window, contested=True, user=user)
    _publish_window_event("dispute.window_contested", window, user=user, comment=comment)
    return window


# --- Открытие спора --------------------------------------------------------


def _create_cap_deadline(dispute: Dispute) -> None:
    """Потолок 30 дней (ADR-020) — от ОТКРЫТИЯ спора, не от размещения
    уведомления: это не тайм-аут ожидания чужого действия, а предельная
    длительность самого разбирательства."""
    now = timezone.now()
    deadline = deadlines_services.create_deadline(
        kind=_DISPUTE_CAP_KIND,
        subject_type="dispute",
        subject_id=dispute.id,
        starts_from="event",
        anchor_at=now,
    )
    dispute.cap_deadline_at = deadline.deadline_at
    dispute.save(update_fields=["cap_deadline_at"])


@transaction.atomic
def open_dispute(
    milestone: Milestone,
    *,
    user: User,
    checklist_item: ChecklistItem,
    evidence: list[str],
) -> Dispute:
    """ADR-017: отклонение приёмки ТОЛЬКО с пунктом чек-листа этого этапа +
    доказательство. Вызывается подписчиком `handlers.handle_milestone_
    rejected` на топик `milestone.rejected` — отклонение приёмки остаётся
    ЕДИНСТВЕННЫМ входом в спор по этапу (отдельного `POST /disputes` нет:
    спора без отклонённой приёмки не бывает)."""
    if checklist_item.milestone_id != milestone.id:
        raise ChecklistItemNotOnMilestoneError(
            f"пункт чек-листа {checklist_item.id} не из этапа {milestone.id}"
        )
    if not evidence:
        raise EvidenceRequiredError("отклонение требует хотя бы одно доказательство")

    dispute = Dispute.objects.create(
        kind=Dispute.Kind.MILESTONE,
        contract=milestone.contract,
        milestone=milestone,
        checklist_item=checklist_item,
        opened_by=user,
        evidence=evidence,
    )
    _create_cap_deadline(dispute)
    # ADR-019: утверждение заказчика «пункт не выполнен» — одностороннее,
    # оно ОТКРЫВАЕТ ОКНО исполнителю, а не налагает последствие.
    open_window(
        kind=_WINDOW_KIND.DISPUTE_RESPONSE,
        contract=dispute.contract,
        dispute=dispute,
        subject_type="dispute",
        subject_id=dispute.id,
    )
    _publish(
        "dispute.opened",
        dispute,
        user=user,
        evidence=evidence,
        opened_by_user_id=str(user.id),
        cap_deadline_at=dispute.cap_deadline_at.isoformat() if dispute.cap_deadline_at else None,
    )
    return dispute


@transaction.atomic
def open_warranty_dispute(
    contract: Contract, *, user: User, description: str, evidence: list[str]
) -> Dispute:
    """Гарантийное разногласие (tech-spec.md §8.8 `POST /contracts/{id}/
    warranty-claims`, ADR-029/030). Вызывается ФАСАДОМ `apps.warranty.
    services.submit_warranty_claim` — сама претензия (`warranty_claim`,
    ОТДЕЛЬНАЯ метрика, рейтинг не пересчитывает) живёт там, здесь только
    диалоговый контур, общий с этапными спорами.

    Этапа у такого спора нет (`kind=warranty`): работы приняты и оплачены,
    претензия — к результату договора целиком."""
    if contract.execution_status != Contract.ExecutionStatus.WARRANTY:
        raise WarrantyPeriodNotActiveError(
            f"договор {contract.id}: гарантийный период не идёт "
            f"(execution_status={contract.execution_status!r})"
        )
    if not evidence:
        raise EvidenceRequiredError("гарантийная претензия требует хотя бы одно доказательство")

    dispute = Dispute.objects.create(
        kind=Dispute.Kind.WARRANTY,
        contract=contract,
        opened_by=user,
        evidence=evidence,
    )
    _create_cap_deadline(dispute)
    open_window(
        kind=_WINDOW_KIND.DISPUTE_RESPONSE,
        contract=contract,
        dispute=dispute,
        subject_type="dispute",
        subject_id=dispute.id,
    )
    _publish(
        "dispute.opened",
        dispute,
        user=user,
        evidence=evidence,
        description=description,
        opened_by_user_id=str(user.id),
        cap_deadline_at=dispute.cap_deadline_at.isoformat() if dispute.cap_deadline_at else None,
    )
    return dispute


# --- Ответ второй стороны --------------------------------------------------


@transaction.atomic
@transaction.atomic
def respond_to_dispute(
    dispute: Dispute, *, user: User, comment: str, evidence: list[str] | None = None
) -> Dispute:
    """`POST /disputes/{id}/respond` — ответ ВТОРОЙ стороны. Закрывает окно
    ответа как ОСПОРЕННОЕ (ADR-019): автоматических последствий нет, разбор
    уходит в диалог. Статус спора не меняется — ответ это реплика, а не
    переход FSM.

    Реплика сохраняется строкой `DisputeReply` (карточка спора отдаёт её в
    `replies`), а не только payload'ом события: outbox — техническая
    таблица реле, источником правды о том, что сторона сказала, быть не
    может."""
    if dispute.status == _STATUS.RESOLVED:
        raise DisputeAlreadyResolvedError(f"спор {dispute.id} уже закрыт")
    _party_role(dispute, user)
    if user.id == dispute.opened_by_id:
        raise NotDisputeCounterpartyError(
            f"пользователь {user.id} открыл спор {dispute.id} — отвечает вторая сторона"
        )
    window = dispute.windows.filter(
        kind=_WINDOW_KIND.DISPUTE_RESPONSE, closed_at__isnull=True
    ).first()
    if window is not None:
        # Закрываем окно БЕЗ отдельного `dispute.window_contested`: ответ по
        # спору и есть возражение, и о нём уже говорит `dispute.responded`
        # ниже — второе событие того же момента дало бы дубль уведомления
        # (граница ADR-126 §4). `dispute.window_contested` остаётся за
        # окнами, у которых своей реплики нет (расторжение, ADR-028).
        _close_window(window, contested=True, user=user)
    reply = DisputeReply.objects.create(
        dispute=dispute, author=user, comment=comment, evidence=evidence or []
    )
    _publish(
        "dispute.responded",
        dispute,
        user=user,
        reply_id=str(reply.id),
        comment=comment,
        response_evidence=evidence or [],
    )
    return dispute


# --- Раунды исправления (tech-spec.md §8.8) --------------------------------


@transaction.atomic
def request_fix(dispute: Dispute, *, user: User, comment: str = "") -> FixRequest:
    """`POST /disputes/{id}/fix-requests` — максимум ДВА раунда
    (`409 fix_rounds_exhausted`, tech-spec.md §8.8; БД-инвариант
    `dispute_fix_rounds_within_cap`). Раунд просит ЗАКАЗЧИК — исправляет
    исполнитель."""
    if dispute.kind != Dispute.Kind.MILESTONE:
        raise DiscountNotApplicableError(
            f"спор {dispute.id} гарантийный — раунды исправления привязаны к сдаче этапа"
        )
    role = _party_role(dispute, user)
    if role != _ROLE.CUSTOMER:
        raise WrongDisputeSideError(
            f"пользователь {user.id} действует как {role!r} — раунд исправления просит заказчик"
        )
    if dispute.fix_rounds_used >= MAX_FIX_ROUNDS:
        raise FixRoundsExhaustedError(
            f"спор {dispute.id}: {MAX_FIX_ROUNDS} раунда исправлений исчерпаны — "
            "дальше скидка-допник, закрытие по согласию, потолок или суд"
        )
    transition = _assert_transition("request_fix", dispute)

    dispute.fix_rounds_used += 1
    dispute.status = transition.target
    dispute.save(update_fields=["fix_rounds_used", "status"])
    fix_request = FixRequest.objects.create(
        dispute=dispute, round=dispute.fix_rounds_used, requested_by=user, comment=comment
    )
    _publish(
        "dispute.fix_requested",
        dispute,
        user=user,
        fix_request_id=str(fix_request.id),
        round=fix_request.round,
        rounds_left=MAX_FIX_ROUNDS - dispute.fix_rounds_used,
        comment=comment,
    )
    return fix_request


@transaction.atomic
def resubmit_fix(fix_request: FixRequest, *, user: User, comment: str = "") -> FixRequest:
    """`POST /disputes/{id}/fix-requests/{fid}/resubmit` — исполнитель сдал
    исправление. Этап возвращается в `under_acceptance` ПОДПИСЧИКОМ
    `apps.milestones.handlers.handle_dispute_fix_resubmitted` на событие
    `dispute.fix_resubmitted` (apps.disputes не зовёт apps.milestones.
    services — см. докстринг модуля)."""
    dispute = fix_request.dispute
    role = _party_role(dispute, user)
    if role != _ROLE.CONTRACTOR:
        raise WrongDisputeSideError(
            f"пользователь {user.id} действует как {role!r} — исправление сдаёт исполнитель"
        )
    if fix_request.resubmitted_at is not None:
        raise FixRequestAlreadyResubmittedError(
            f"раунд {fix_request.round} спора {dispute.id} уже сдан"
        )
    transition = _assert_transition("resubmit_fix", dispute)

    now = timezone.now()
    fix_request.resubmitted_at = now
    fix_request.resubmitted_by = user
    fix_request.resubmit_comment = comment
    fix_request.save(update_fields=["resubmitted_at", "resubmitted_by", "resubmit_comment"])
    dispute.status = transition.target
    dispute.save(update_fields=["status"])
    _publish(
        "dispute.fix_resubmitted",
        dispute,
        user=user,
        fix_request_id=str(fix_request.id),
        round=fix_request.round,
        rounds_left=MAX_FIX_ROUNDS - dispute.fix_rounds_used,
        comment=comment,
    )
    return fix_request


# --- Скидка = допник (tech-spec.md §5.2.7, §8.8; §20.3 анти-waiver) --------

# `cause` в payload `amendment.rejected`, когда допник скидки закрыт отказом
# от скидки (`decline_discount`), а не кнопкой допника: реестры уведомлений
# (settings.NOTIFICATION_TOPIC_*) по этому ключу глушат дубль.
DISCOUNT_DECLINED_CAUSE = "discount_declined"


@transaction.atomic
def propose_discount(
    dispute: Dispute,
    *,
    user: User,
    new_amount: Decimal,
    currency: str,
    anti_waiver_note: str,
    reason: str = "",
) -> DiscountAgreement:
    """`POST /disputes/{id}/discount-proposal` — «создаёт допник (требует
    подписи, ADR-048); анти-waiver: скидка закрывает только указанный дефект
    (§20.3) — фиксируется в payload».

    ПРИНЯТИЕ скидки — это ПОДПИСЬ допника обеими сторонами общим контуром
    §8.6, а не отдельная кнопка в споре: иначе было бы два источника правды
    о том, вступила ли скидка в силу. Спор закрывается подписчиком на
    `contract.amended` (`handlers.handle_contract_amended`)."""
    milestone = dispute.milestone
    if dispute.kind != Dispute.Kind.MILESTONE or milestone is None:
        raise DiscountNotApplicableError(
            f"спор {dispute.id} гарантийный — скидка меняет сумму листа, а листа тут нет"
        )
    if milestone.amount is None or milestone.amount_currency is None:
        raise DiscountNotApplicableError(f"у этапа {milestone.id} нет суммы — нечего уменьшать")
    if currency != milestone.amount_currency:
        raise DiscountNotApplicableError(
            f"валюта скидки {currency!r} != валюты этапа {milestone.amount_currency!r}"
        )
    if new_amount >= milestone.amount or new_amount < 0:
        raise DiscountNotApplicableError(
            f"скидка должна быть меньше суммы этапа ({milestone.amount}) и неотрицательной"
        )
    if not anti_waiver_note.strip():
        raise DiscountNotApplicableError(
            "анти-waiver-оговорка обязательна (§20.3): скидка закрывает только указанный дефект"
        )
    _party_role(dispute, user)
    transition = _assert_transition("propose_discount", dispute)

    amendment = contracts_services.create_discount_amendment(
        dispute.contract,
        user=user,
        milestone_id=milestone.id,
        new_amount=new_amount,
        currency=currency,
        reason=reason or f"Скидка по разногласию {dispute.id}",
        anti_waiver_note=anti_waiver_note,
        checklist_item_id=dispute.checklist_item_id,
    )
    agreement = DiscountAgreement.objects.create(
        dispute=dispute,
        amendment=amendment,
        milestone=milestone,
        proposed_by=user,
        old_amount=milestone.amount,
        old_amount_currency=milestone.amount_currency,
        new_amount=new_amount,
        new_amount_currency=currency,
        anti_waiver_note=anti_waiver_note,
    )
    dispute.status = transition.target
    dispute.save(update_fields=["status"])
    _publish(
        "dispute.discount_proposed",
        dispute,
        user=user,
        discount_agreement_id=str(agreement.id),
        amendment_id=str(amendment.id),
        old_amount=str(agreement.old_amount),
        new_amount=str(agreement.new_amount),
        currency=currency,
        anti_waiver_note=anti_waiver_note,
    )
    return agreement


@transaction.atomic
def decline_discount(
    agreement: DiscountAgreement, *, user: User, comment: str = ""
) -> DiscountAgreement:
    """`POST /disputes/{id}/discount-proposals/{did}/decline` — вторая
    сторона не согласна. Спор возвращается в `open`, а допник скидки в той
    же транзакции закрывается как отклонённый второй стороной
    (`contracts_services.reject_amendment`, `rejected_by_counterparty`,
    актор — отказавший, `reason` — его комментарий; решение владельца 26.08
    «в6-6: автоматически», дополнение 26.08 к ADR-131). Из заморозки —
    с аннулированием раунда подписания допника, как при ручном reject.

    Одно действие — одно уведомление (ADR-126 §4): о моменте говорит
    `dispute.discount_declined`; `amendment.rejected` публикуется с
    `cause="discount_declined"`, и реестры уведомлений по этому ключу его
    глушат (факт остаётся в хронике допника и Audit Vault). Подписчик
    `handlers.handle_amendment_closed` на этом же событии — NOOP: предложение
    уже `declined`, спор уже `open`."""
    dispute = agreement.dispute
    if agreement.status != DiscountAgreement.Status.PROPOSED:
        raise DiscountAlreadyDecidedError(
            f"предложение скидки {agreement.id} уже {agreement.status}"
        )
    _party_role(dispute, user)
    if user.id == agreement.proposed_by_id:
        raise NotDisputeCounterpartyError(
            f"пользователь {user.id} сам предложил скидку {agreement.id} — решает вторая сторона"
        )
    transition = _assert_transition("decline_discount", dispute)

    now = timezone.now()
    agreement.status = DiscountAgreement.Status.DECLINED
    agreement.decided_by = user
    agreement.decided_at = now
    agreement.save(update_fields=["status", "decided_by", "decided_at"])
    dispute.status = transition.target
    dispute.save(update_fields=["status"])
    amendment = agreement.amendment
    # Живой допник — только в одном из трёх состояний согласования: подписанный
    # закрыл бы предложение как `accepted` (contract.amended), отклонённый/
    # отозванный — как `declined` (amendment.rejected/withdrawn), и до этой
    # строки мы бы не дошли. Проверка FSM — страховка, не ветка логики.
    amendment_rejected = contracts_services.NEGOTIATION_FSM.can_transition(
        "reject", amendment.negotiation_status
    )
    _publish(
        "dispute.discount_declined",
        dispute,
        user=user,
        discount_agreement_id=str(agreement.id),
        amendment_id=str(agreement.amendment_id),
        comment=comment,
        amendment_rejected=amendment_rejected,
    )
    if amendment_rejected:
        contracts_services.reject_amendment(
            amendment, user=user, reason=comment, cause=DISCOUNT_DECLINED_CAUSE
        )
    return agreement


@transaction.atomic
def accept_discount_by_amendment(
    amendment: Amendment, *, actor_user_id: str | None
) -> Dispute | None:
    """Допник скидки подписан обеими сторонами (`contract.amended` ->
    `handlers.handle_contract_amended`): сумма листа УЖЕ изменена
    `apps.contracts.services.apply_amendment` в той же транзакции подписи.
    Здесь — фиксация исхода и закрытие спора.

    Инвариант «сумма листьев = сумма договора» держится сам собой: отдельной
    строки «сумма договора» нет, `effective_terms`/`total_leaf_amount`
    считают её ПО ЛИСТЬЯМ (докстринг `apps.contracts.services.
    effective_terms`: «total_amount — ЖИВАЯ сумма»), поэтому изменение листа
    допником и есть изменение суммы договора."""
    agreement = (
        DiscountAgreement.objects.filter(
            amendment=amendment, status=DiscountAgreement.Status.PROPOSED
        )
        .select_related("dispute__contract", "dispute__milestone")
        .first()
    )
    if agreement is None:
        return None
    now = timezone.now()
    agreement.status = DiscountAgreement.Status.ACCEPTED
    agreement.decided_at = now
    agreement.save(update_fields=["status", "decided_at"])
    user = User.objects.filter(pk=actor_user_id).first() if actor_user_id else None
    return resolve_dispute(agreement.dispute, user=user, resolution_type="discount_accepted")


@transaction.atomic
def cancel_discount_by_amendment(
    amendment: Amendment, *, actor_user_id: str | None, cause: str
) -> Dispute | None:
    """Допник скидки отозван инициатором (`amendment.withdrawn`) или отклонён
    второй стороной (`amendment.rejected`) контуром §8.6 (дополнение 26.08 к
    ADR-075) -> `handlers.handle_amendment_closed`. Спор не должен зависнуть
    в `awaiting_discount` без живого допника: предложение помечается
    `declined`, спор возвращается в `open` тем же переходом
    `decline_discount`, что и прямой отказ от скидки.

    Событие — `dispute.discount_cancelled` (с `cause`), а НЕ
    `dispute.discount_declined`: о самом действии уже уведомляет
    `amendment.rejected`/`amendment.withdrawn`, второе уведомление о том же
    моменте было бы дублем (ADR-126 §4); топик в реестры уведомлений не
    маппится, остаётся для ленты спора и Audit Vault. Обычный допник (не
    скидка) или уже решённое предложение — None, NOOP (идемпотентность реле,
    ADR-064). Сюда же приходит `amendment.rejected`, рождённый самим
    `decline_discount` (cause=discount_declined): предложение уже `declined`
    — та же ветка NOOP, зацикливания нет."""
    agreement = (
        DiscountAgreement.objects.filter(
            amendment=amendment, status=DiscountAgreement.Status.PROPOSED
        )
        .select_related("dispute__contract", "dispute__milestone")
        .first()
    )
    if agreement is None:
        return None
    dispute = agreement.dispute
    if dispute.status != _STATUS.AWAITING_DISCOUNT:
        return None
    transition = _assert_transition("decline_discount", dispute)
    now = timezone.now()
    agreement.status = DiscountAgreement.Status.DECLINED
    agreement.decided_by = User.objects.filter(pk=actor_user_id).first() if actor_user_id else None
    agreement.decided_at = now
    agreement.save(update_fields=["status", "decided_by", "decided_at"])
    dispute.status = transition.target
    dispute.save(update_fields=["status"])
    _publish(
        "dispute.discount_cancelled",
        dispute,
        user=agreement.decided_by,
        discount_agreement_id=str(agreement.id),
        amendment_id=str(amendment.id),
        cause=cause,
    )
    return dispute


# --- Закрытие спора --------------------------------------------------------


@transaction.atomic
def resolve_dispute(dispute: Dispute, *, user: User | None, resolution_type: str) -> Dispute:
    """`POST /disputes/{id}/resolve` (согласие сторон, снятие отклонения,
    передача в суд) ЛИБО системный исход: потолок 30 дней (`cap_reached`,
    ADR-020) и подписанная скидка (`discount_accepted`).

    ADR-020 (потолок): «принятые этапы оплачиваются, спорный целиком
    остаётся неоплаченным». Первое верно без нашего участия (принятые листья
    живут своим `accepted -> paid`), второе — тоже: `apps.milestones.
    handlers.handle_dispute_resolved` возвращает этап в `accepted` ТОЛЬКО
    для исходов диалога (`accepted`/`withdrawn`/`discount_accepted`), а при
    `cap_reached` этап остаётся `disputed` и не оплачивается. Референсные
    метрики обеим сторонам — из события (apps.reputation строит карточку
    исключительно по outbox)."""
    if dispute.status == _STATUS.RESOLVED:
        raise DisputeAlreadyResolvedError(f"спор {dispute.id} уже закрыт")
    outcome = RESOLUTION_OUTCOME.get(resolution_type)
    if outcome is None:
        raise ValueError(f"неизвестный исход спора {resolution_type!r}")
    required_role = _WARRANTY_RESOLUTION_ROLE.get(resolution_type)
    if required_role is not None and user is not None:
        # Гарантийные исходы — строго от «своей» стороны: отказать может
        # только та сторона, К КОТОРОЙ претензия предъявлена (исполнитель),
        # подтвердить устранение — только та, КТО её предъявил (заказчик;
        # ADR-133). Чужая сторона исказила бы исход в ленте и в счётчике
        # претензий (ADR-030). `user=None` — системный исход (авто-
        # подтверждение по свипу окна), гарда нет.
        role = _party_role(dispute, user)
        if role != required_role:
            raise WrongDisputeSideError(
                f"пользователь {user.id} действует как {role!r} — исход "
                f"{resolution_type!r} доступен стороне {required_role!r}"
            )
    transition = _assert_transition("resolve", dispute)

    now = timezone.now()
    dispute.status = transition.target
    dispute.resolution_type = resolution_type
    dispute.outcome = outcome
    dispute.resolved_at = now
    dispute.save(update_fields=["status", "resolution_type", "outcome", "resolved_at"])

    # Незакрытые окна снимаются: оспаривать больше нечего (исход есть).
    # `contested=None` при заполненном `closed_at` — ровно этот случай
    # (CheckConstraint dispute_window_outcome_implies_closed его допускает).
    for window in dispute.windows.filter(closed_at__isnull=True):
        _close_window(window, contested=None, user=None)

    _publish(
        "dispute.resolved",
        dispute,
        user=user,
        resolution_type=resolution_type,
        outcome=outcome,
        resolved_at=now.isoformat(),
    )
    if outcome == _OUTCOME.CAP_REACHED:
        # Отдельное событие потолка (ADR-020: «референсные последствия обеим
        # сторонам, не санкция») — раздельно с `dispute.resolved`, тем же
        # приёмом, что `contract.completed` рядом с `contract.warranty_started`
        # (док 31 §7: самостоятельный неизменяемый исход для карточки ГВ.4).
        _publish(
            "dispute.cap_reached",
            dispute,
            user=None,
            resolution_type=resolution_type,
            outcome=outcome,
            reference_metric="dispute_unresolved_at_cap",
        )
    return dispute


def days_to_cap(dispute: Dispute, *, at: datetime | None = None) -> int | None:
    """«Дней до потолка» для `GET /disputes` (tech-spec.md §8.8). None — если
    потолок неизвестен (спор из данных до ADR-131) или спор уже закрыт."""
    if dispute.cap_deadline_at is None or dispute.status == _STATUS.RESOLVED:
        return None
    remaining: timedelta = dispute.cap_deadline_at - (at or timezone.now())
    return max(remaining.days, 0)
