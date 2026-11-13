"""Use cases apps.warranty (tech-spec.md §8.8 `GET/POST /contracts/{id}/
warranty-claims`; domain-model.md §12; ADR-029/030, ADR-131).

Гарантийный ПЕРИОД самим этим приложением не заводится: он уже реализован
контуром исполнения — `apps.contracts.services.complete_execution` публикует
`contract.warranty_started` и создаёт дедлайн `contract_warranty`, свип
переводит договор `warranty -> closed` (`apps.contracts.handlers`). Здесь —
ЗАЯВКИ внутри этого периода.

Направление зависимостей: apps.warranty -> apps.disputes (services-фасад) и
-> apps.contracts. Обратно никто не ходит: закрытие заявки по исходу спора —
подписчик `handlers.handle_dispute_resolved` на outbox-топик.

ADR-133 — цикл «устранил -> подтвердил / не устранено» (`submit_warranty_fix`
/ `satisfy_warranty_claim` / `contest_warranty_claim`) и автоподтверждение по
дедлайну `warranty_claim_acceptance` (строка `DomainDeadline` + свип, НЕ
отложенная задача; длительность — из `DeadlineKindConfig`, засеяна равной
окну приёмки этапа `milestone_acceptance`). Дополнение 26.08 (в6-8):
усиленная серия напоминаний по окну подтверждения —
`ReminderPointConfig(kind="warranty_claim_acceptance")`, те же точки, что у
приёмки этапа; стартует в `submit_warranty_fix` прямым размещением
уведомления заказчику (как `milestones.services.submit_milestone`)."""

from __future__ import annotations

from django.db import transaction
from django.utils import timezone

from apps.accounts.models import User
from apps.contracts import selectors as contracts_selectors
from apps.contracts import services as contracts_services
from apps.contracts.models import Contract, ContractParty
from apps.deadlines import selectors as deadlines_selectors
from apps.deadlines import services as deadlines_services
from apps.disputes import selectors as disputes_selectors
from apps.disputes import services as disputes_services
from apps.disputes.models import MAX_FIX_ROUNDS
from apps.notifications import services as notifications_services
from common import outbox

from .models import WarrantyClaim, WarrantyFix

_ROLE = ContractParty.Role
_STATUS = WarrantyClaim.Status
# Категория дедлайна окна подтверждения (длительность — данные,
# `DeadlineKindConfig`, миграция deadlines/0007: равна `milestone_acceptance`).
ACCEPTANCE_DEADLINE_KIND = "warranty_claim_acceptance"


class NotCustomerError(ValueError):
    """Гарантийную претензию подаёт ЗАКАЗЧИК — он получатель результата
    (domain-model.md §12)."""


class NotContractorError(ValueError):
    """Отказать по претензии может только ИСПОЛНИТЕЛЬ — сторона, к которой
    она предъявлена."""


class ClaimAlreadyResolvedError(ValueError):
    """Повторное закрытие уже закрытой заявки."""


class ClaimDisputeMissingError(ValueError):
    """У заявки нет диалога (`dispute_id` пуст или спор удалён) — отказать
    «в обход» диалогового контура нельзя, исход претензии = исход спора."""


class ClaimNotAwaitingConfirmationError(ValueError):
    """Возразить «не устранено» можно только пока претензия ждёт
    подтверждения (исполнитель сообщил об устранении)."""


class ClaimAlreadyAwaitingConfirmationError(ValueError):
    """Повторное «устранил» без ответа заказчика: окно подтверждения уже идёт."""


class FixRoundsExhaustedError(ValueError):
    """`409 fix_rounds_exhausted` — потолок возражений «не устранено» тот же,
    что у раундов исправления спора по этапу (`MAX_FIX_ROUNDS`); дальше —
    подтверждение, отказ исполнителя, суд или потолок 30 дней."""


def _payload(claim: WarrantyClaim, **extra: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "warranty_claim_id": str(claim.id),
        "contract_id": str(claim.contract_id),
        "dispute_id": str(claim.dispute_id) if claim.dispute_id else None,
        "parties": contracts_selectors.party_identity_snapshot(claim.contract),
        "occurred_at": timezone.now().isoformat(),
    }
    payload.update(extra)
    return payload


@transaction.atomic
def submit_warranty_claim(
    contract: Contract, *, user: User, description: str, evidence: list[str]
) -> WarrantyClaim:
    """`POST /contracts/{id}/warranty-claims`. Открывает СПОР типа `warranty`
    через фасад apps.disputes — диалоговый контур (окно ответа, потолок
    30 дней, закрытие) один и тот же, дублировать его здесь незачем.

    Проверку «гарантийный период идёт» делает фасад
    (`disputes_services.open_warranty_dispute` -> `WarrantyPeriodNotActive
    Error`), а не эта функция: инвариант один, источник правды один — иначе
    два места разъедутся, когда `ExecutionStatus` пополнится."""
    party = contracts_services.get_party_for_user(contract, user)
    if party.role != _ROLE.CUSTOMER:
        raise NotCustomerError(
            f"пользователь {user.id} действует как {party.role!r} — "
            "гарантийную претензию подаёт заказчик"
        )
    dispute = disputes_services.open_warranty_dispute(
        contract, user=user, description=description, evidence=evidence
    )
    claim = WarrantyClaim.objects.create(
        contract=contract,
        submitted_by=user,
        description=description,
        evidence=evidence,
        dispute_id=dispute.id,
    )
    outbox.publish(
        "warranty.claim_submitted",
        subject={
            "type": "warranty_claim",
            "id": str(claim.id),
            "contract_id": str(contract.id),
        },
        payload=_payload(claim, description=description, evidence=evidence),
        actor={"user_id": str(user.id)},
    )
    return claim


@transaction.atomic
def resolve_warranty_claim(
    claim: WarrantyClaim,
    *,
    resolution_type: str,
    user: User | None = None,
    auto: bool = False,
) -> WarrantyClaim:
    """Закрытие заявки. Вызывается ПОДПИСЧИКОМ на `dispute.resolved`
    (`handlers.handle_dispute_resolved`) — исход диалога и есть исход
    претензии; отдельной кнопки «закрыть заявку» нет, иначе появилось бы
    два расходящихся источника правды. Единственное исключение —
    `decline_warranty_claim` ниже: там та же запись, но событие
    `warranty.claim_declined` и синхронно с исходом спора.

    `user` — актор исхода спора (кто закрыл `/resolve`), `auto` — исход
    системный (потолок 30 дней свипом, `cap_reached`): у события актора нет.

    ADR-030: рейтинг задним числом НЕ пересчитывается — событие несёт
    `affects_reputation: false`, и `apps.reputation` этот топик не слушает
    (settings.OUTBOX_SUBSCRIBERS)."""
    return _close_claim(
        claim,
        resolution_type=resolution_type,
        user=user,
        auto=auto,
        topic="warranty.claim_resolved",
    )


@transaction.atomic
def decline_warranty_claim(claim: WarrantyClaim, *, user: User, comment: str = "") -> WarrantyClaim:
    """`POST /warranty-claims/{id}/decline` — ИСПОЛНИТЕЛЬ отказывает по
    претензии (хвост волны 4: у `resolution_type=warranty_declined` не было
    ни своей кнопки, ни проверки роли).

    Исход претензии = исход спора, поэтому сначала закрывается диалог
    (`disputes_services.resolve_dispute(..., "warranty_declined")` — там же
    гард роли и `409 dispute_already_resolved`), затем — в ТОЙ ЖЕ транзакции
    — сама заявка. Подписчик `handlers.handle_dispute_resolved` на уже
    закрытой заявке отработает NOOP (идемпотентность ADR-064), второй строки
    не будет.

    Событие — `warranty.claim_declined` ВМЕСТО `warranty.claim_resolved`, а
    не рядом с ним: это один и тот же момент, два уведомления о нём были бы
    дублем (граница ADR-126 §4). Потребители метрики претензий (ADR-030)
    слушают оба топика. `comment` — текст отказа, уходит в payload и в
    уведомление заказчику."""
    if claim.status == WarrantyClaim.Status.RESOLVED:
        raise ClaimAlreadyResolvedError(f"гарантийная заявка {claim.id} уже закрыта")
    party = contracts_services.get_party_for_user(claim.contract, user)
    if party.role != _ROLE.CONTRACTOR:
        raise NotContractorError(
            f"пользователь {user.id} действует как {party.role!r} — "
            "отказать по гарантийной претензии может исполнитель"
        )
    dispute = disputes_selectors.get_dispute(claim.dispute_id) if claim.dispute_id else None
    if dispute is None:
        raise ClaimDisputeMissingError(f"у гарантийной заявки {claim.id} нет диалога")
    disputes_services.resolve_dispute(dispute, user=user, resolution_type="warranty_declined")
    return _close_claim(
        claim,
        resolution_type="warranty_declined",
        user=user,
        topic="warranty.claim_declined",
        comment=comment,
    )


# --- ADR-133: устранил -> подтвердил / не устранено / авто --------------------


def _assert_open(claim: WarrantyClaim) -> None:
    if claim.status == _STATUS.RESOLVED:
        raise ClaimAlreadyResolvedError(f"гарантийная заявка {claim.id} уже закрыта")


def _assert_role(claim: WarrantyClaim, user: User, role: str) -> None:
    party = contracts_services.get_party_for_user(claim.contract, user)
    if party.role != role:
        if role == _ROLE.CUSTOMER:
            raise NotCustomerError(
                f"пользователь {user.id} действует как {party.role!r} — "
                "подтверждает или оспаривает устранение заказчик"
            )
        raise NotContractorError(
            f"пользователь {user.id} действует как {party.role!r} — "
            "об устранении сообщает исполнитель"
        )


def _cancel_acceptance_deadline(claim: WarrantyClaim) -> None:
    """Окно подтверждения снимается ПАУЗОЙ дедлайна (как окна спора,
    `apps.disputes.services._close_window`): свип фильтрует `paused=False`,
    удаления дедлайнов в проекте нет. Пауза снимает и серию напоминаний:
    `apps.notifications.tasks.sweep_reminder_schedules` не шлёт напоминания
    по приостановленным дедлайнам. Не сохраняет `claim` — вызывающий
    пишет `acceptance_deadline_id=None` вместе со сменой статуса."""
    if claim.acceptance_deadline_id is None:
        return
    deadline = deadlines_selectors.get_deadline(claim.acceptance_deadline_id)
    if deadline is not None and deadline.fired_at is None and not deadline.paused:
        deadlines_services.pause_deadline(deadline, reason="warranty_claim_acceptance_closed")
    claim.acceptance_deadline_id = None


def acceptance_deadline_at(claim: WarrantyClaim) -> object | None:
    """`deadline_at` окна подтверждения для карточки претензии; None, пока
    уведомление не размещено в ЛК (ADR-057: окно не тикает до юридической
    доставки) или окна нет."""
    if claim.acceptance_deadline_id is None:
        return None
    deadline = deadlines_selectors.get_deadline(claim.acceptance_deadline_id)
    return deadline.deadline_at if deadline is not None else None


@transaction.atomic
def submit_warranty_fix(
    claim: WarrantyClaim, *, user: User, comment: str = "", evidence: list[str] | None = None
) -> WarrantyFix:
    """`POST /warranty-claims/{id}/fix-submitted` — ИСПОЛНИТЕЛЬ сообщает, что
    недостаток устранён: `submitted -> awaiting_confirmation`, строка
    `WarrantyFix(round=fix_rounds_used+1)`, дедлайн `warranty_claim_acceptance`
    со `starts_from=cabinet_placement` — тикает с момента размещения
    уведомления `warranty.fix_submitted` в ЛК ЗАКАЗЧИКА (ADR-057).
    Молчание заказчика в окно — авто-`warranty_satisfied`
    (`auto_satisfy_warranty_claim`, подписчик свипа).

    Уведомление заказчику размещается ПРЯМЫМ вызовом `place_notification`
    здесь же (тот же приём, что окно приёмки этапа в
    `apps.milestones.services.submit_milestone`), а не подписчиком на
    событие: `place_notification` якорит дедлайн и планирует усиленную серию
    напоминаний (`ReminderPointConfig(kind="warranty_claim_acceptance")`,
    дополнение 26.08 к ADR-133) ДЛЯ ПОЛУЧАТЕЛЯ этого уведомления — а
    подписчик размещает сначала актору (исполнителю), и серия ушла бы не той
    стороне. Поэтому в реестре контрагента (settings.NOTIFICATION_TOPIC_
    COUNTERPARTY_TEMPLATES) `warranty.fix_submitted` нет; исполнителю
    (актору — самому себе) копию ADR-178 больше не размещает: реестр
    адресата (settings.NOTIFICATION_TOPIC_ADDRESSEE_TEMPLATES) эту строку
    не несёт, а «своё действие зафиксировано» видно в хронике заявки.
    Побочное следствие: окно тикает и `acceptance_deadline_at` заполнен уже
    в ответе этого POST."""
    _assert_open(claim)
    if claim.status == _STATUS.AWAITING_CONFIRMATION:
        raise ClaimAlreadyAwaitingConfirmationError(
            f"гарантийная заявка {claim.id} уже ждёт подтверждения заказчика"
        )
    _assert_role(claim, user, _ROLE.CONTRACTOR)
    evidence = evidence or []
    now = timezone.now()
    fix = WarrantyFix.objects.create(
        claim=claim,
        round=claim.fix_rounds_used + 1,
        submitted_by=user,
        comment=comment,
        evidence=evidence,
    )
    deadline = deadlines_services.create_deadline(
        kind=ACCEPTANCE_DEADLINE_KIND,
        subject_type="warranty_claim",
        subject_id=claim.id,
        starts_from="cabinet_placement",
    )
    claim.status = _STATUS.AWAITING_CONFIRMATION
    claim.fix_submitted_at = now
    claim.acceptance_deadline_id = deadline.id
    claim.save(update_fields=["status", "fix_submitted_at", "acceptance_deadline_id"])
    payload = _payload(
        claim,
        fix_id=str(fix.id),
        round=fix.round,
        rounds_left=claim.fix_rounds_left,
        comment=comment,
        evidence=evidence,
    )
    customer_user = contracts_selectors.party_user(
        claim.contract.parties.select_related("profile__owner_entity").get(role=_ROLE.CUSTOMER)
    )
    if customer_user is not None:
        notifications_services.place_notification(
            recipient=customer_user,
            template="warranty.fix_submitted",
            payload=dict(payload),
            legal_significance=True,
            subject_type="warranty_claim",
            subject_id=str(claim.id),
            subject_contract_id=str(claim.contract_id),
        )
    outbox.publish(
        "warranty.fix_submitted",
        subject={
            "type": "warranty_claim",
            "id": str(claim.id),
            "contract_id": str(claim.contract_id),
        },
        payload=payload,
        actor={"user_id": str(user.id)},
    )
    return fix


@transaction.atomic
def satisfy_warranty_claim(claim: WarrantyClaim, *, user: User, comment: str = "") -> WarrantyClaim:
    """`POST /warranty-claims/{id}/satisfy` — ЗАКАЗЧИК подтверждает, что
    недостаток устранён (симметрично `decline_warranty_claim`: гард роли
    здесь И в `disputes.resolve_dispute` для исхода `warranty_satisfied`).
    Из любого незакрытого статуса: подтвердить можно и без формального
    «устранил» (сделали на месте). Спор и заявка закрываются в одной
    транзакции исходом `warranty_satisfied`; окно подтверждения снимается.
    Событие — `warranty.claim_satisfied` ВМЕСТО `warranty.claim_resolved`
    (один момент — одно уведомление, ADR-126 §4)."""
    _assert_open(claim)
    _assert_role(claim, user, _ROLE.CUSTOMER)
    dispute = disputes_selectors.get_dispute(claim.dispute_id) if claim.dispute_id else None
    if dispute is None:
        raise ClaimDisputeMissingError(f"у гарантийной заявки {claim.id} нет диалога")
    disputes_services.resolve_dispute(dispute, user=user, resolution_type="warranty_satisfied")
    return _close_claim(
        claim,
        resolution_type="warranty_satisfied",
        user=user,
        topic="warranty.claim_satisfied",
        comment=comment,
    )


@transaction.atomic
def auto_satisfy_warranty_claim(claim: WarrantyClaim) -> WarrantyClaim | None:
    """Свип: окно подтверждения истекло молча (`domain_deadline.fired`,
    kind=`warranty_claim_acceptance` -> `handlers.handle_deadline_fired`) —
    авто-`warranty_satisfied`, как автоприёмка этапа
    (`apps.milestones.services.finalize_acceptance(auto=True)`): актор пуст
    (системное действие), уведомление обеим сторонам, `auto=True` в payload.

    Только из `awaiting_confirmation` — если заказчик успел возразить или
    претензия закрыта иначе, NOOP. Если спор уже закрыт другим исходом
    (например, потолок 30 дней сработал тем же свипом), заявку закроет
    `handle_dispute_resolved` — здесь тоже NOOP."""
    if claim.status != _STATUS.AWAITING_CONFIRMATION:
        return None
    dispute = disputes_selectors.get_dispute(claim.dispute_id) if claim.dispute_id else None
    if dispute is None:
        raise ClaimDisputeMissingError(f"у гарантийной заявки {claim.id} нет диалога")
    try:
        disputes_services.resolve_dispute(dispute, user=None, resolution_type="warranty_satisfied")
    except disputes_services.DisputeAlreadyResolvedError:
        return None
    return _close_claim(
        claim,
        resolution_type="warranty_satisfied",
        user=None,
        topic="warranty.claim_auto_satisfied",
        auto=True,
    )


@transaction.atomic
def contest_warranty_claim(
    claim: WarrantyClaim, *, user: User, comment: str, evidence: list[str] | None = None
) -> WarrantyClaim:
    """`POST /warranty-claims/{id}/contest` — ЗАКАЗЧИК: «не устранено».
    Только из `awaiting_confirmation`; считает возражение раундом
    (`fix_rounds_used += 1`, потолок `MAX_FIX_ROUNDS` — тот же, что у раундов
    спора: третье возражение — `409 fix_rounds_exhausted`), снимает окно
    подтверждения и возвращает претензию исполнителю (`submitted`)."""
    _assert_open(claim)
    if claim.status != _STATUS.AWAITING_CONFIRMATION:
        raise ClaimNotAwaitingConfirmationError(
            f"гарантийная заявка {claim.id} не ждёт подтверждения — возражать нечему"
        )
    _assert_role(claim, user, _ROLE.CUSTOMER)
    if claim.fix_rounds_used >= MAX_FIX_ROUNDS:
        raise FixRoundsExhaustedError(
            f"гарантийная заявка {claim.id}: {MAX_FIX_ROUNDS} возражения «не устранено» "
            "исчерпаны — дальше подтверждение, отказ исполнителя, суд или потолок"
        )
    evidence = evidence or []
    now = timezone.now()
    fix = claim.fixes.filter(contested_at__isnull=True).order_by("-round").first()
    if fix is not None:
        fix.contested_by = user
        fix.contested_at = now
        fix.contest_comment = comment
        fix.contest_evidence = evidence
        fix.save(
            update_fields=["contested_by", "contested_at", "contest_comment", "contest_evidence"]
        )
    _cancel_acceptance_deadline(claim)
    claim.fix_rounds_used += 1
    claim.status = _STATUS.SUBMITTED
    claim.fix_submitted_at = None
    claim.save(
        update_fields=["fix_rounds_used", "status", "fix_submitted_at", "acceptance_deadline_id"]
    )
    outbox.publish(
        "warranty.claim_contested",
        subject={
            "type": "warranty_claim",
            "id": str(claim.id),
            "contract_id": str(claim.contract_id),
        },
        payload=_payload(
            claim,
            fix_id=str(fix.id) if fix is not None else None,
            round=claim.fix_rounds_used,
            rounds_left=claim.fix_rounds_left,
            comment=comment,
            evidence=evidence,
        ),
        actor={"user_id": str(user.id)},
    )
    return claim


def _close_claim(
    claim: WarrantyClaim,
    *,
    resolution_type: str,
    user: User | None,
    topic: str,
    auto: bool = False,
    **extra: object,
) -> WarrantyClaim:
    """`auto=True` — закрытие системой без действия сторон (окно
    подтверждения истекло, потолок спора): `resolved_by` пуст, в API —
    `resolved_auto=true` (дополнение 26.08 к ADR-133). Ручное закрытие
    пишет `resolved_by` — заказчика, исполнителя или сторону, закрывшую спор."""
    if claim.status == WarrantyClaim.Status.RESOLVED:
        raise ClaimAlreadyResolvedError(f"гарантийная заявка {claim.id} уже закрыта")
    now = timezone.now()
    # Любое закрытие снимает окно подтверждения, если оно шло (в т.ч. отказ
    # исполнителя и закрытие по исходу спора подписчиком).
    _cancel_acceptance_deadline(claim)
    claim.status = WarrantyClaim.Status.RESOLVED
    claim.resolution_type = resolution_type
    claim.resolved_at = now
    claim.resolved_by = user
    claim.resolved_auto = auto
    claim.save(
        update_fields=[
            "status",
            "resolution_type",
            "resolved_at",
            "resolved_by",
            "resolved_auto",
            "acceptance_deadline_id",
        ]
    )
    outbox.publish(
        topic,
        subject={
            "type": "warranty_claim",
            "id": str(claim.id),
            "contract_id": str(claim.contract_id),
        },
        payload=_payload(
            claim,
            resolution_type=resolution_type,
            # ADR-030 — метка в самом событии, чтобы потребитель не гадал.
            affects_reputation=False,
            auto=auto,
            **extra,
        ),
        actor={"user_id": str(user.id)} if user is not None else {},
    )
    return claim
