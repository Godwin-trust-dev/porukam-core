"""Read-модель ГВ.4 (docs/tasks/global-wave.md). Ничего здесь не пишется
напрямую по HTTP-запросу — единственный писатель `subscriber.handle_event`,
реагирующий на outbox-события (см. README.md)."""

from __future__ import annotations

from django.db import models
from django.db.models import Q

from common.uuid7 import uuid7


class ProcessedEvent(models.Model):
    """Идемпотентность подписчика по `event_id` (тот же приём, что
    `services.audit_vault.models.AuditEntry.source_event_id`, ADR-065):
    `event_id` — PRIMARY KEY, повторная доставка того же события падает на
    `get_or_create`/INSERT, а не удваивает счётчики `DealFact`."""

    event_id = models.UUIDField(primary_key=True)
    topic = models.CharField(max_length=200)
    processed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "reputation_processed_event"
        verbose_name = "обработанное событие"
        verbose_name_plural = "обработанные события"

    def __str__(self) -> str:
        return f"{self.topic}:{self.event_id}"


class DealFact(models.Model):
    """Одна строка на договор — накапливается по мере прихода событий
    Э4.6, попадает в списки карточек ОБЕИХ сторон только когда
    `is_completed=True` (событие `contract.completed` пришло). Контракты,
    завершившиеся расторжением (`contract.terminated`), в ГВ.4 не
    учитываются — задача перечисляет только события-исходы
    `milestone.*`/`dispute.*`/`contract.completed`; `contract.terminated`
    — расширение на будущее (см. `docs/adr/ADR-076-reputation-card-read-model.md`).

    `sphere_codes` — список, не одно значение: дерево этапов
    «мультисферно» (разные сферы в разных ветках одного договора,
    `apps.catalog.models.Sphere` докстринг), одна сделка может нести
    несколько сфер работ."""

    class Outcome(models.TextChoices):
        COMPLETED = "completed", "Завершена"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    contract_id = models.UUIDField(unique=True)

    contract_type_code = models.CharField(max_length=64, blank=True, default="")
    segment = models.CharField(max_length=32, blank=True, default="")

    customer_profile_id = models.UUIDField(null=True, blank=True)
    contractor_profile_id = models.UUIDField(null=True, blank=True)

    sphere_codes = models.JSONField(default=list, blank=True)
    last_milestone_title = models.CharField(max_length=200, blank=True, default="")

    period_start = models.DateTimeField(null=True, blank=True)
    period_end = models.DateTimeField(null=True, blank=True)

    milestones_accepted = models.PositiveIntegerField(default=0)
    milestones_rejected = models.PositiveIntegerField(default=0)
    disputes_opened = models.PositiveIntegerField(default=0)
    disputes_resolved = models.PositiveIntegerField(default=0)
    dispute_resolutions = models.JSONField(default=list, blank=True)

    # --- ADR-163 (макет владельца 05.09), волна 2 -------------------------
    # ДЕНОРМАЛИЗАЦИЯ поверх `MilestoneFact`: карточка не должна сканировать
    # этапы, чтобы показать долю. Оба счётчика пишет ОДИН И ТОТ ЖЕ
    # подписчик в ОДНОЙ транзакции со строкой этапа — разъехаться им негде
    # (тот же приём, что денежное зеркало на Milestone, ADR-130).
    #
    # ОСЬ ИСПОЛНИТЕЛЯ: этап сдан до дедлайна этапа. `*_with_due` —
    # знаменатель: этапы БЕЗ дедлайна в долю не входят вовсе (мерить
    # нечего), а не считаются просроченными.
    milestones_on_time = models.PositiveIntegerField(default=0)
    milestones_with_due = models.PositiveIntegerField(default=0)
    # ОСЬ ЗАКАЗЧИКА №1: платёж по этапу подтверждён плательщиком до срока
    # оплаты (`payment_settlement`, ADR-130).
    payments_on_time = models.PositiveIntegerField(default=0)
    payments_with_due = models.PositiveIntegerField(default=0)
    # ОСЬ ЗАКАЗЧИКА №2: приёмка завершена В ОКНЕ приёмки и НЕ автоприёмкой
    # по тайм-ауту. Автоприёмка — принятый этап для исполнителя и
    # «затянуто» для заказчика: два разных факта об одном событии
    # (ADR-163 §1).
    acceptances_prompt = models.PositiveIntegerField(default=0)
    acceptances_measured = models.PositiveIntegerField(default=0)
    # ADR-030: гарантийные обращения — ОТДЕЛЬНАЯ метрика, рейтинг задним
    # числом не пересчитывается; поэтому счётчик, а не доля, и он не входит
    # ни в один знаменатель.
    warranty_claims = models.PositiveIntegerField(default=0)

    # ADR-163 §4: считаем, но публично НЕ отдаём — только приватный
    # `/insights` владельца. Деньги — всегда парой (CLAUDE.md), валюты по
    # умолчанию нет: `null` означает «сумма не пришла», не «0 ₽».
    total_amount = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)
    total_currency = models.CharField(max_length=3, null=True, blank=True)
    # Способ расчётов и уровень защиты договора (`Contract.protected` —
    # источник правды об «уровне защиты платежа», выводить его из способа
    # заново значило бы завести второе определение защищённости).
    # `payment_protected=None` — договор завершился до раскатки поля.
    payment_method = models.CharField(max_length=32, blank=True, default="")
    payment_protected = models.BooleanField(null=True, blank=True)

    outcome = models.CharField(max_length=16, choices=Outcome.choices, blank=True, default="")
    is_completed = models.BooleanField(default=False)
    completed_at = models.DateTimeField(null=True, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "reputation_deal_fact"
        verbose_name = "факт сделки"
        verbose_name_plural = "факты сделок"
        indexes = [
            models.Index(fields=["customer_profile_id"]),
            models.Index(fields=["contractor_profile_id"]),
        ]
        constraints = [
            # «Тип, сфера, период, исход, контрагент» — читается только у
            # ЗАВЕРШЁННЫХ сделок (список ГВ.4); не готовая полностью строка
            # не должна попадать в выдачу карточки ни по какой ошибке
            # агрегации.
            models.CheckConstraint(
                condition=(Q(is_completed=False) | Q(completed_at__isnull=False)),
                name="reputation_deal_fact_completed_has_completed_at",
            ),
            # CLAUDE.md: деньги — всегда пара (amount, currency); валюты по
            # умолчанию нет нигде. Сумма без валюты (и наоборот) — не
            # «почти правильная» строка, а невосстановимая: в `/insights`
            # объём пришлось бы показывать без единиц.
            models.CheckConstraint(
                condition=(
                    Q(total_amount__isnull=True, total_currency__isnull=True)
                    | Q(total_amount__isnull=False, total_currency__isnull=False)
                ),
                name="reputation_deal_fact_total_amount_currency_together",
            ),
        ]

    def __str__(self) -> str:
        return f"deal:{self.contract_id}"

    def counterparty_profile_id(self, viewer_profile_id: object) -> object:
        if str(self.customer_profile_id) == str(viewer_profile_id):
            return self.contractor_profile_id
        return self.customer_profile_id


class MilestoneFact(models.Model):
    """Read-модель НА ЭТАП (ADR-163 §9) — рядом с `DealFact`, тем же
    подписчиком и в той же транзакции.

    Зачем вторая таблица: `DealFact` хранит уже сложенные счётчики и
    физически не может ответить «какой именно этап сдан с опозданием и
    почему вернули». Приватный экран Insights владельца раскрывает каждую
    цифру в конкретные этапы — для этого нужна строка на этап; публичная
    карточка её не читает вовсе (ей хватает денормализованных счётчиков
    `DealFact`).

    Обе стороны хранятся на строке (а не берутся из `DealFact`) по той же
    причине, что и там: read-модель отвечает на «покажи мои этапы» одним
    индексируемым запросом, не джойня договор.

    Строка НЕ юрзначима и не является источником правды — источник
    остаётся в `apps.milestones`/`apps.payments`; здесь только проекция
    событий (`docs/adr/ADR-076-reputation-card-read-model.md`)."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    milestone_id = models.UUIDField(unique=True)
    contract_id = models.UUIDField()

    title = models.CharField(max_length=300, blank=True, default="")
    sphere_code = models.CharField(max_length=64, blank=True, default="")

    customer_profile_id = models.UUIDField(null=True, blank=True)
    contractor_profile_id = models.UUIDField(null=True, blank=True)

    # Ось исполнителя. `delivered_on_time=None` — дедлайна у этапа не было,
    # мерить нечего (в знаменатель не идёт).
    due_at = models.DateTimeField(null=True, blank=True)
    submitted_at = models.DateTimeField(null=True, blank=True)
    delivered_on_time = models.BooleanField(null=True, blank=True)

    # Ось заказчика №2 — приёмка. `auto_accepted=True` (тайм-аут) —
    # `acceptance_prompt=False` всегда, независимо от окна.
    accepted_at = models.DateTimeField(null=True, blank=True)
    auto_accepted = models.BooleanField(default=False)
    acceptance_prompt = models.BooleanField(null=True, blank=True)

    # Ось заказчика №1 — оплата (срок приходит из apps.payments через
    # payload, ADR-163 §6).
    payment_due_at = models.DateTimeField(null=True, blank=True)
    payment_confirmed_at = models.DateTimeField(null=True, blank=True)
    payment_on_time = models.BooleanField(null=True, blank=True)

    # «Почему вернули» — описание пункта чек-листа последнего отклонения
    # (ADR-017: без пункта отклонить нельзя, поэтому оно всегда есть).
    rejections = models.PositiveIntegerField(default=0)
    last_rejected_at = models.DateTimeField(null=True, blank=True)
    last_rejection_reason = models.TextField(blank=True, default="")

    disputes_opened = models.PositiveIntegerField(default=0)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "reputation_milestone_fact"
        verbose_name = "факт этапа"
        verbose_name_plural = "факты этапов"
        indexes = [
            models.Index(fields=["contract_id"]),
            models.Index(fields=["customer_profile_id"]),
            models.Index(fields=["contractor_profile_id"]),
        ]

    def __str__(self) -> str:
        return f"milestone:{self.milestone_id}"
