"""Use cases apps.deadlines (tech-spec.md §2.5, §5.2.10; docs/tasks/fundament.md
ЭФ.2; ADR-039, ADR-057; docs/adr/ADR-072-domain-deadline-sweep.md).

Срабатывание (fired_at + событие в outbox) — не здесь, а в apps.deadlines.tasks
(sweep — фоновый процесс, не use case по запросу вызывающей стороны)."""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime, timedelta
from uuid import UUID

from django.db import transaction
from django.db.models import F
from django.utils import timezone

from .models import DeadlineKindConfig, DomainDeadline


class DeadlineKindNotConfiguredError(ValueError):
    """Для `kind` нет строки в DeadlineKindConfig — длительность неизвестна
    (CLAUDE.md: значения длительностей только из конфигурации, не константы
    в коде; tech-spec.md §11 п.4)."""


class DeadlineAlreadyAnchoredError(ValueError):
    """anchor_deadline() вызван повторно на уже заякоренном дедлайне —
    anchor_at проставляется РОВНО ОДИН РАЗ (момент юридической доставки,
    ADR-057)."""


def _duration_for(kind: str) -> timedelta:
    try:
        return DeadlineKindConfig.objects.get(kind=kind).duration
    except DeadlineKindConfig.DoesNotExist as exc:
        raise DeadlineKindNotConfiguredError(
            f"для категории {kind!r} нет строки в DeadlineKindConfig"
        ) from exc


def _effective_duration(deadline: DomainDeadline) -> timedelta:
    """ADR-140: своя длительность дедлайна (из условий договора) главнее
    длительности категории; категория при этом ОБЯЗАНА существовать —
    override не способ завести дедлайн без конфигурации."""
    kind_duration = _duration_for(deadline.kind)
    return deadline.duration_override if deadline.duration_override is not None else kind_duration


@transaction.atomic
def create_deadline(
    *,
    kind: str,
    subject_type: str,
    subject_id: UUID,
    starts_from: str,
    anchor_at: datetime | None = None,
    deadline_at: datetime | None = None,
    duration: timedelta | None = None,
) -> DomainDeadline:
    """`anchor_at` передаётся сразу только для `starts_from=event` (отсчёт
    известен в момент создания). Для `starts_from=cabinet_placement` дедлайн
    создаётся НЕЗАЯКОРЕННЫМ (deadline_at IS NULL, не тикает) — заякорить его
    обязана apps.deadlines.services.anchor_deadline() при размещении
    уведомления в ЛК (связка с ЭФ.4).

    `deadline_at` — явный момент срабатывания для ПРОИЗВОДНЫХ дедлайнов
    (ADR-136/137: «уведомить за N дней до другого дедлайна» — это `другой −
    N`, а не `anchor + duration(kind)`); требует `anchor_at`, категория
    всё равно обязана быть в DeadlineKindConfig (её длительность — тот самый
    N, и он остаётся данными).

    `duration` — ADR-140: длительность из условий ЭТОГО договора (окно
    приёмки этапа); None — длительность категории. Должна быть положительной."""
    if duration is not None and duration <= timedelta(0):
        raise ValueError(f"duration дедлайна должна быть положительной, получено {duration}")
    deadline = DomainDeadline(
        kind=kind,
        subject_type=subject_type,
        subject_id=subject_id,
        starts_from=starts_from,
        duration_override=duration,
    )
    if anchor_at is not None:
        duration = _effective_duration(deadline)
        deadline.anchor_at = anchor_at
        deadline.deadline_at = deadline_at if deadline_at is not None else anchor_at + duration
    elif deadline_at is not None:
        raise ValueError("явный deadline_at требует anchor_at")
    deadline.save()
    return deadline


@transaction.atomic
def anchor_deadline(deadline: DomainDeadline, *, at: datetime) -> DomainDeadline:
    """Простановка `anchor_at` (ЭФ.4: вызывается apps.notifications.services.
    place_notification в момент размещения уведомления в ЛК). До вызова
    дедлайн существует, но не тикает — sweep фильтрует по deadline_at,
    оно NULL до анкоринга."""
    if deadline.anchor_at is not None:
        raise DeadlineAlreadyAnchoredError(
            f"дедлайн {deadline.id} уже заякорен в {deadline.anchor_at}"
        )
    deadline.anchor_at = at
    deadline.deadline_at = at + _effective_duration(deadline)
    deadline.save(update_fields=["anchor_at", "deadline_at"])
    return deadline


class DeadlineAlreadyFiredError(ValueError):
    """reschedule_deadline()/close_deadline() вызваны на уже сработавшем
    (fired_at IS NOT NULL) дедлайне — сработавший дедлайн терминален, его
    судьбу решил обработчик срабатывания; «продлить» его нельзя, только
    завести новый."""


@transaction.atomic
def reschedule_deadline(deadline: DomainDeadline, *, anchor_at: datetime) -> DomainDeadline:
    """ADR-138: перенос ЗАЯКОРЕННОГО и ещё не сработавшего дедлайна на новый
    отсчёт — `anchor_at` заменяется, `deadline_at` пересчитывается по
    актуальной длительности категории. В отличие от `anchor_deadline`
    (ровно один раз, момент юридической доставки, ADR-057) здесь перенос —
    штатная операция: дедлайн «без движения по договору» (`contract_idle`)
    сдвигается при КАЖДОМ движении, и делать это обновлением одной строки, а
    не новой строкой на каждое сообщение в чате (иначе таблица росла бы на
    каждое действие сторон)."""
    if deadline.fired_at is not None:
        raise DeadlineAlreadyFiredError(
            f"дедлайн {deadline.id} уже сработал в {deadline.fired_at} — переносить нечего"
        )
    deadline.anchor_at = anchor_at
    deadline.deadline_at = anchor_at + _effective_duration(deadline)
    deadline.save(update_fields=["anchor_at", "deadline_at"])
    return deadline


@transaction.atomic
def close_deadline(deadline: DomainDeadline, *, outcome: str) -> DomainDeadline:
    """ADR-138: досрочное закрытие дедлайна доменной причиной — субъект ушёл
    из состояния, в котором тайм-аут имел смысл (договор завершён/расторгнут
    до истечения `contract_idle`). Строка получает `fired_at` и `outcome`,
    но событие `domain_deadline.fired` НЕ публикуется: срабатывания не было.
    Нужно ради серии напоминаний: `apps.notifications.tasks.
    sweep_reminder_schedules` отбирает напоминания только по дедлайнам с
    `fired_at IS NULL` — без закрытия предупреждение «договор будет закрыт»
    ушло бы сторонам уже завершённого договора."""
    if deadline.fired_at is not None:
        raise DeadlineAlreadyFiredError(
            f"дедлайн {deadline.id} уже сработал в {deadline.fired_at} — закрывать нечего"
        )
    deadline.fired_at = timezone.now()
    deadline.outcome = outcome
    deadline.save(update_fields=["fired_at", "outcome"])
    return deadline


def pause_deadline(deadline: DomainDeadline, *, reason: str) -> DomainDeadline:
    """domain-model.md §7 (Milestone `in_progress ⇄ suspended`): пауза
    ОДНОГО дедлайна по доменной причине — не путать с
    `compensate_downtime()` (массовый сдвиг всех активных при простое
    платформы, ADR-039)."""
    deadline.paused = True
    deadline.pause_reason = reason
    deadline.save(update_fields=["paused", "pause_reason"])
    return deadline


def resume_deadline(deadline: DomainDeadline) -> DomainDeadline:
    deadline.paused = False
    deadline.pause_reason = None
    deadline.save(update_fields=["paused", "pause_reason"])
    return deadline


def shift_deadline(deadline: DomainDeadline, *, by: timedelta) -> DomainDeadline:
    """Сдвиг ОДНОГО активного заякоренного дедлайна (ADR-136: возобновление
    RetentionTimer после паузы на спор — срок продлевается ровно на
    длительность паузы, иначе «пауза» с истёкшим `deadline_at` сработала бы
    в первую же минуту после закрытия спора). Незаякоренный или уже
    сработавший — не трогаем, возвращаем как есть."""
    if deadline.fired_at is not None or deadline.deadline_at is None:
        return deadline
    deadline.deadline_at = deadline.deadline_at + by
    deadline.save(update_fields=["deadline_at"])
    return deadline


def shift_deadlines_for_subjects(
    *, subject_type: str, subject_ids: Iterable[UUID], by: timedelta
) -> int:
    """Точечный сдвиг дедлайнов КОНКРЕТНОГО списка субъектов — частный случай
    `compensate_downtime` (тот двигает ВСЕ активные дедлайны платформы при
    простое, ADR-039). «Общий сервис» (etap-4.md Э4.6: «frozen_days сдвигает
    последующие дедлайны») — вызывающая сторона (напр. apps.milestones при
    разморозке этапа — зависимые этапы) сама решает, какие субъекты
    сдвигать; здесь только механика UPDATE. Незаякоренные (`deadline_at IS
    NULL`) и уже сработавшие не трогаем — тот же фильтр, что
    `compensate_downtime`."""
    ids = list(subject_ids)
    if not ids:
        return 0
    return DomainDeadline.objects.filter(
        subject_type=subject_type,
        subject_id__in=ids,
        fired_at__isnull=True,
        deadline_at__isnull=False,
    ).update(deadline_at=F("deadline_at") + by)


def compensate_downtime(downtime: timedelta) -> int:
    """ADR-039: `deadline_at += downtime` для ВСЕХ активных (fired_at IS
    NULL) заякоренных дедлайнов — включая поставленные на паузу (их
    deadline_at сдвигается заранее, на случай резюмирования). Незаякоренные
    (deadline_at IS NULL) и уже сработавшие — не трогаем. Возвращает число
    затронутых строк."""
    return DomainDeadline.objects.filter(fired_at__isnull=True, deadline_at__isnull=False).update(
        deadline_at=F("deadline_at") + downtime
    )
