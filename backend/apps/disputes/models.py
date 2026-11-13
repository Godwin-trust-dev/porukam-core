"""tech-spec.md §4 (`disputes` — "Споры, окна оспаривания, инструменты
диалога, медиация", ADR 017-020), §5.2.7; domain-model.md §11.

Этап 7 (docs/plan.md «Этап 7. Споры и гарантия», ADR-131): полный контур
поверх модели-заглушки Э4.6 — два раунда исправлений (`FixRequest`,
`409 fix_rounds_exhausted`), скидка допником (`DiscountAgreement` — сам
допник живёт в `apps.contracts`, здесь только связка и анти-waiver),
окна оспаривания (`DisputeWindow`, ADR-019), потолок 30 дней (ADR-020) и
гарантийные разногласия (`Dispute.kind=warranty`, претензия — в
`apps.warranty`).

`milestone`/`checklist_item` — FK на apps.milestones (import-linter НЕ
запрещает apps.disputes зависеть от apps.milestones — запрет только
`apps.contracts` -> `apps.payments`/`apps.disputes`, pyproject.toml
[[tool.importlinter.contracts]]). Обратного импорта (apps.milestones.services
-> apps.disputes.services, для открытия спора при отклонении) без цикла:
apps.disputes НИКОГДА не импортирует apps.milestones.services — реакция на
исход спора (возврат этапа в приёмку/принятие) идёт ТОЛЬКО через outbox
(topic `dispute.resolved`/`dispute.fix_resubmitted`, apps.milestones.handlers),
тот же приём, что apps.profiles реагирует на `entity.claimed`."""

from __future__ import annotations

from django.conf import settings
from django.db import models
from django.db.models import F, Q

from common.uuid7 import uuid7

# Потолок раундов исправления (tech-spec.md §5.2.7
# `fix_rounds_used int CHECK (fix_rounds_used <= 2)`): два раунда — это
# продуктовое решение, зафиксированное в схеме БД, а не параметр категории,
# поэтому константа кода, а не строка DeadlineKindConfig.
MAX_FIX_ROUNDS = 2


class Dispute(models.Model):
    """Спор по этапу (domain-model.md §11 `Dispute`, ADR-017: «отклонение —
    ТОЛЬКО с пунктом чек-листа + доказательство») ИЛИ по гарантии
    (`kind=warranty`, tech-spec.md §5.2.7 `warranty_claim` — претензия
    заводится в `apps.warranty`, диалоговый контур один и тот же).

    `contract` — денормализованная (относительно `milestone__contract`)
    ссылка, потому что у гарантийного спора этапа НЕТ: договор уже
    `warranty`, претензия относится к результату целиком. Согласованность
    пары «этап из этого договора» держит БД-триггер
    `dispute_milestone_contract_guard` (миграция 0002) — CHECK его выразить
    не может (условие ссылается на ДРУГУЮ таблицу, тот же случай, что
    `milestone_amount_guard`).

    `evidence` — список `apps.evidence.EvidenceItem.id`/`apps.documents.
    Document.id` строками, не FK (тот же приём, что `AmendmentChange.target`).

    `resolution_type` — детальный код исхода (`accepted`, `withdrawn`,
    `discount_accepted`, `cap_reached`, `escalated_to_court`,
    `warranty_satisfied`, `warranty_declined`); `outcome` — грубая
    классификация из tech-spec.md §5.2.7 (`resolved|cap_reached|
    escalated_to_court`), она и несёт CHECK-констрейнт. Два поля, а не одно:
    `resolution_type` уже читают `apps.milestones.handlers` и
    `apps.reputation.subscriber` (сузить его до трёх значений спеки нельзя
    без потери смысла), а `outcome` — контракт схемы."""

    class Kind(models.TextChoices):
        MILESTONE = "milestone", "По этапу"
        WARRANTY = "warranty", "Гарантийный"

    class Status(models.TextChoices):
        OPEN = "open", "Открыт"
        AWAITING_FIX = "awaiting_fix", "Ожидает исправления"
        AWAITING_DISCOUNT = "awaiting_discount", "Ожидает решения по скидке"
        RESOLVED = "resolved", "Закрыт"

    class Outcome(models.TextChoices):
        RESOLVED = "resolved", "Урегулирован"
        CAP_REACHED = "cap_reached", "Закрыт по предельному сроку"
        ESCALATED_TO_COURT = "escalated_to_court", "Передан в суд"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    kind = models.CharField(max_length=16, choices=Kind.choices, default=Kind.MILESTONE)
    contract = models.ForeignKey(
        "contracts.Contract", related_name="disputes", on_delete=models.CASCADE
    )
    milestone = models.ForeignKey(
        "milestones.Milestone",
        related_name="disputes",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
    )
    checklist_item = models.ForeignKey(
        "milestones.ChecklistItem",
        related_name="disputes",
        null=True,
        blank=True,
        on_delete=models.PROTECT,
    )
    opened_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="+", on_delete=models.PROTECT
    )
    evidence = models.JSONField(default=list, blank=True)
    status = models.CharField(max_length=24, choices=Status.choices, default=Status.OPEN)
    fix_rounds_used = models.PositiveSmallIntegerField(default=0)
    resolution_type = models.CharField(max_length=32, blank=True, default="")
    outcome = models.CharField(max_length=32, choices=Outcome.choices, blank=True, default="")
    opened_at = models.DateTimeField(auto_now_add=True)
    # tech-spec.md §5.2.7 `cap_deadline_at` — денормализация строки
    # `apps.deadlines.DomainDeadline(kind="dispute_cap")` РАДИ ЧТЕНИЯ
    # (`GET /disputes` отдаёт «дней до потолка» без join'а в чужое
    # приложение); источник истины срабатывания — по-прежнему свип
    # apps.deadlines, не это поле.
    cap_deadline_at = models.DateTimeField(null=True, blank=True)
    resolved_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "dispute"
        verbose_name = "спор"
        verbose_name_plural = "споры"
        ordering = ["-opened_at"]
        constraints = [
            # tech-spec.md §5.2.7: fix_rounds_used <= 2 — БД-инвариант, а не
            # только проверка сервиса (CLAUDE.md: «БД-инварианты на живом
            # PostgreSQL»). Литерал вместо MAX_FIX_ROUNDS: значение попадает
            # в миграцию, и её нельзя задним числом менять правкой константы.
            models.CheckConstraint(
                condition=Q(fix_rounds_used__lte=2),
                name="dispute_fix_rounds_within_cap",
            ),
            # ADR-017: спор по этапу невозможен без пункта чек-листа
            # («нет пункта -> нечего оспаривать»); гарантийный спор, наоборот,
            # ни к какому этапу не привязан.
            models.CheckConstraint(
                condition=(
                    Q(kind="milestone", milestone__isnull=False, checklist_item__isnull=False)
                    | Q(kind="warranty", milestone__isnull=True, checklist_item__isnull=True)
                ),
                name="dispute_kind_subject_consistent",
            ),
            # Закрытый спор всегда имеет исход и дату, открытый — ни того ни
            # другого.
            models.CheckConstraint(
                condition=(
                    (Q(status="resolved", resolved_at__isnull=False) & ~Q(outcome=""))
                    | (~Q(status="resolved") & Q(resolved_at__isnull=True, outcome=""))
                ),
                name="dispute_resolved_has_outcome",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.contract_id}:{self.kind}:{self.status}"


class FixRequest(models.Model):
    """Раунд исправления (tech-spec.md §8.8 `POST /disputes/{id}/fix-requests`,
    domain-model.md §11 `fix_rounds_used: int  # максимум 2`).

    Раунд — ПАРА действий: заказчик просит исправить (`requested_at`),
    исполнитель сдаёт исправление (`resubmitted_at`) — этап при этом
    возвращается в `under_acceptance` через outbox (`dispute.fix_resubmitted`
    -> apps.milestones.handlers), а не прямым вызовом."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    dispute = models.ForeignKey(Dispute, related_name="fix_requests", on_delete=models.CASCADE)
    round = models.PositiveSmallIntegerField()
    requested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="+", on_delete=models.PROTECT
    )
    comment = models.TextField(blank=True, default="")
    requested_at = models.DateTimeField(auto_now_add=True)
    resubmitted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="+", null=True, blank=True, on_delete=models.PROTECT
    )
    resubmit_comment = models.TextField(blank=True, default="")
    resubmitted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "fix_request"
        verbose_name = "раунд исправления"
        verbose_name_plural = "раунды исправления"
        ordering = ["dispute_id", "round"]
        constraints = [
            models.UniqueConstraint(fields=["dispute", "round"], name="fix_request_round_unique"),
            models.CheckConstraint(
                condition=Q(round__gte=1) & Q(round__lte=2),
                name="fix_request_round_within_cap",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.dispute_id}:{self.round}"


class DisputeReply(models.Model):
    """Реплика стороны в диалоге по разногласию (`POST /disputes/{id}/respond`,
    tech-spec.md §8.8 «инструменты диалога»).

    До хвоста волны 4 (backlog 25.08) текст ответа жил ТОЛЬКО в payload
    outbox-события `dispute.responded` — то есть в технической таблице
    реле, которую чистят и которую API не читает; карточка спора реплику не
    показывала. Ответ на разногласие — юрзначимое заявление стороны (ADR-019:
    возражение в срок отменяет автоматические последствия), поэтому у него
    своя строка, а не поиск по outbox. `evidence` — тот же формат, что у
    `Dispute.evidence` (id доказательств строками). Реплика — НЕ переход FSM:
    статус спора она не меняет."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    dispute = models.ForeignKey(Dispute, related_name="replies", on_delete=models.CASCADE)
    author = models.ForeignKey(settings.AUTH_USER_MODEL, related_name="+", on_delete=models.PROTECT)
    comment = models.TextField(blank=True, default="")
    evidence = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "dispute_reply"
        verbose_name = "реплика по разногласию"
        verbose_name_plural = "реплики по разногласию"
        ordering = ["created_at"]

    def __str__(self) -> str:
        return f"{self.dispute_id}:{self.author_id}"


class DiscountAgreement(models.Model):
    """Скидка = ДОПНИК (tech-spec.md §5.2.7: «discount_agreement подписывается
    через общий контур amendment (скидка = допник с MODIFY_MILESTONE)»,
    §8.8 «создаёт допник (требует подписи, ADR-048)»).

    Эта строка — НЕ второй контур согласования, а связка «спор <-> допник» и
    место для анти-waiver-оговорки §20.3 («скидка закрывает только указанный
    дефект»): она уходит и в `payload` изменения допника (то есть в
    подписываемый снимок), и остаётся здесь для ленты спора.

    Принятие — подпись допника обеими сторонами общим контуром §8.6; спор
    закрывается подписчиком на `contract.amended` (apps.disputes.handlers),
    а не отдельной кнопкой «принять скидку» — иначе было бы ДВА источника
    правды о том, вступила ли скидка в силу.

    `amendment` — FK на apps.contracts (разрешено: import-linter запрещает
    обратное направление, `contracts` -> `disputes`)."""

    class Status(models.TextChoices):
        PROPOSED = "proposed", "Предложена"
        ACCEPTED = "accepted", "Принята"
        DECLINED = "declined", "Отклонена"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    dispute = models.ForeignKey(
        Dispute, related_name="discount_agreements", on_delete=models.CASCADE
    )
    amendment = models.ForeignKey(
        "contracts.Amendment", related_name="discount_agreements", on_delete=models.PROTECT
    )
    milestone = models.ForeignKey(
        "milestones.Milestone", related_name="discount_agreements", on_delete=models.CASCADE
    )
    proposed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="+", on_delete=models.PROTECT
    )
    # Money-пары (CLAUDE.md: валюты по умолчанию НЕТ нигде).
    old_amount = models.DecimalField(max_digits=14, decimal_places=2)
    old_amount_currency = models.CharField(max_length=3)
    new_amount = models.DecimalField(max_digits=14, decimal_places=2)
    new_amount_currency = models.CharField(max_length=3)
    # §20.3: скидка закрывает ТОЛЬКО указанный дефект — текст оговорки
    # фиксируется в снимке допника, здесь хранится ровно то, что подписано.
    anti_waiver_note = models.TextField()
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PROPOSED)
    decided_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="+", null=True, blank=True, on_delete=models.PROTECT
    )
    decided_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "discount_agreement"
        verbose_name = "соглашение о скидке"
        verbose_name_plural = "соглашения о скидке"
        ordering = ["-created_at"]
        constraints = [
            # Скидка УМЕНЬШАЕТ сумму листа: «предложение», которое дороже
            # исходного, — не скидка, а доработка за деньги (для неё есть
            # обычный допник, §8.6).
            models.CheckConstraint(
                condition=Q(new_amount__lt=F("old_amount")),
                name="discount_agreement_reduces_amount",
            ),
            # Скидка не может увести сумму листа в минус.
            models.CheckConstraint(
                condition=Q(new_amount__gte=0), name="discount_agreement_new_amount_non_negative"
            ),
            # Валюта скидки — та же, что у листа (конвертации в контуре нет).
            models.CheckConstraint(
                condition=Q(new_amount_currency=F("old_amount_currency")),
                name="discount_agreement_same_currency",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.dispute_id}:{self.status}"


class DisputeWindow(models.Model):
    """Окно оспаривания (tech-spec.md §5.2.7 `dispute_window`, ADR-019:
    «односторонние утверждения не создают автоматических последствий» — они
    ОТКРЫВАЮТ ОКНО: не оспорено в срок -> факт зафиксирован; оспорено ->
    автоматических последствий нет, событие уходит в диалог).

    Тайм-аут окна — строка `apps.deadlines.DomainDeadline` (CLAUDE.md:
    дедлайны — строки в БД + свип раз в минуту, НЕ отложенные Celery-задачи)
    со `starts_from=cabinet_placement`: отсчёт идёт от РАЗМЕЩЕНИЯ уведомления
    в ЛК (ADR-057), а не от вызова сервиса. `deadline_id` — по значению, без
    FK: apps.deadlines — нижний технический реестр, жёсткая ссылка связала бы
    чистку дедлайнов с юрзначимой строкой окна.

    `subject_ref` — jsonb из спеки (`{"type": ..., "id": ...}`): у окна ответа
    по спору субъект — сам спор, у окна оспаривания расторжения — договор."""

    class Kind(models.TextChoices):
        DISPUTE_RESPONSE = "dispute_response", "Ответ на разногласие"
        TERMINATION_NOTICE = "termination_notice", "Оспаривание расторжения"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    kind = models.CharField(max_length=32, choices=Kind.choices)
    contract = models.ForeignKey(
        "contracts.Contract", related_name="dispute_windows", on_delete=models.CASCADE
    )
    dispute = models.ForeignKey(
        Dispute, related_name="windows", null=True, blank=True, on_delete=models.CASCADE
    )
    subject_ref = models.JSONField(default=dict, blank=True)
    deadline_id = models.UUIDField(null=True, blank=True)
    opened_at = models.DateTimeField(auto_now_add=True)
    deadline_at = models.DateTimeField(null=True, blank=True)
    # True — оспорено (диалог, автоматических последствий нет); False —
    # истекло молча (факт зафиксирован); NULL — окно ещё идёт ЛИБО снято
    # досрочно (`closed_at` заполнен, а исхода нет: спор урегулирован раньше
    # срока — оспаривать стало нечего). Ровно поле `contested bool NULL`
    # спеки, отдельного `status` нет.
    contested = models.BooleanField(null=True, blank=True)
    contested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="+", null=True, blank=True, on_delete=models.PROTECT
    )
    contested_at = models.DateTimeField(null=True, blank=True)
    closed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "dispute_window"
        verbose_name = "окно оспаривания"
        verbose_name_plural = "окна оспаривания"
        ordering = ["-opened_at"]
        constraints = [
            # Исход есть -> окно закрыто. Обратное неверно: закрытое досрочно
            # окно исхода не имеет (спор урегулирован раньше срока).
            models.CheckConstraint(
                condition=Q(contested__isnull=True) | Q(closed_at__isnull=False),
                name="dispute_window_outcome_implies_closed",
            ),
            models.CheckConstraint(
                condition=(
                    Q(contested=True, contested_by__isnull=False, contested_at__isnull=False)
                    | ~Q(contested=True)
                ),
                name="dispute_window_contested_has_author",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.kind}:{self.contract_id}"
