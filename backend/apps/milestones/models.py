"""tech-spec.md §5.2.5, §6.3; domain-model.md §7. Э4.3 (docs/tasks/etap-4.md):
дерево этапов, чек-листы, материалы. Заморозка/подписание (Э4.4); Э4.5 —
допники, `created_by_amendment` FK на `apps.contracts.Amendment` (domain-model.md
§7.1: `None` — этап из исходного договора, `UUID` — создан допником).
Исполнение — гейт/сдача/приёмка: Э4.6 подключает FSM переходов между
значениями `Milestone.status` (объявлены целиком ещё в Э4.3 как дефолт с
момента создания строки) в `services.py`, и добавляет поля гейта/денежных
заглушек НОВОЙ миграцией (0004, CLAUDE.md: миграции не редактируются после
применения, только новые) — см. докстринги полей ниже.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models
from django.db.models import Q

from apps.contracts.models import Amendment, Contract
from common.uuid7 import uuid7

# Глубина дерева — [Т-решение] (tech-spec.md §5.2.5): не выражается
# декларативно в PostgreSQL (родитель — та же таблица), проверяется в
# apps.milestones.services при вставке.
MAX_TREE_DEPTH = 6


class Milestone(models.Model):
    """Узел дерева этапов. Ветки группируют, ЛИСТЬЯ принимаются/оплачиваются
    (domain-model.md §7.1). `amount`/`amount_currency` — ТОЛЬКО у листьев,
    гарантируется `milestone_amount_guard` (БД-триггер, миграция 0002) —
    БД-инвариант, не выражаемый CHECK-констрейнтом (условие ссылается на
    наличие ДЕТЕЙ строки, декларативно недоступно)."""

    class Status(models.TextChoices):
        PENDING = "pending", "Ожидает"
        IN_PROGRESS = "in_progress", "В работе"
        SUSPENDED = "suspended", "Приостановлен"
        UNDER_ACCEPTANCE = "under_acceptance", "На приёмке"
        ACCEPTED = "accepted", "Принят"
        DISPUTED = "disputed", "Оспаривается"
        PAID = "paid", "Оплачен"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    contract = models.ForeignKey(Contract, related_name="milestones", on_delete=models.CASCADE)
    parent = models.ForeignKey(
        "self", related_name="children", null=True, blank=True, on_delete=models.CASCADE
    )
    order = models.PositiveIntegerField(default=0)
    title = models.CharField(max_length=300)
    status = models.CharField(max_length=32, choices=Status.choices, default=Status.PENDING)

    # Money-пара (CLAUDE.md: валюты по умолчанию нет нигде) — обе части
    # заполнены только у листьев (milestone_amount_guard).
    amount = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)
    amount_currency = models.CharField(max_length=3, null=True, blank=True)

    sphere = models.ForeignKey(
        "catalog.Sphere",
        related_name="milestones",
        null=True,
        blank=True,
        on_delete=models.PROTECT,
    )
    deadline = models.DateTimeField(null=True, blank=True)
    depends_on = models.ForeignKey(
        "self", related_name="+", null=True, blank=True, on_delete=models.SET_NULL
    )
    # None — этап из исходного договора; заполнен — создан допником (Э4.5),
    # PROTECT — допник не может исчезнуть, пока на него ссылается этап,
    # который он породил (та же логика, что Contract.frozen_version).
    created_by_amendment = models.ForeignKey(
        Amendment,
        related_name="created_milestones",
        null=True,
        blank=True,
        on_delete=models.PROTECT,
    )
    frozen_days = models.PositiveIntegerField(default=0)
    submitted_at = models.DateTimeField(null=True, blank=True)
    accepted_at = models.DateTimeField(null=True, blank=True)
    # Э4.6 (etap-4.md, migration 0004): гейт листа (§6.3) и денежные
    # заглушки-подтверждения способов расчёта БЕЗ платёжного контура (Э5).
    # `started_at` — момент прохода гейта (pending -> in_progress), нужен и
    # domain-model.md §7.3 `delivery_deadline(base=STAGE_START)` (Э4.3 её не
    # материализовала — не от чего было считать).
    started_at = models.DateTimeField(null=True, blank=True)
    # Двустороннее подтверждение оплаты листа для офлайн-способов
    # (cash/external) — ЗЕРКАЛО `apps.payments.models.Payment` (ADR-130),
    # пишет его только платёжный контур. Момент подтверждения зависит от
    # `Contract.payment_order` (ADR-155): при `after_acceptance` — после
    # приёмки (`accepted -> paid`), при `before_start` — ДО старта листа, и
    # тогда лист закрывается `paid` в момент приёмки. Для
    # direct_platform/hold полноценные платежи — Р2, здесь эти поля не
    # используются (см. apps.milestones.services.confirm_payment).
    # Полей `advance_confirmed_*` больше нет: способ `prepayment` упразднён
    # (ADR-155), предоплата — это `payment_order=before_start`, и платёж по
    # листу у неё тот же самый, а не второй.
    paid_confirmed_by_customer_at = models.DateTimeField(null=True, blank=True)
    paid_confirmed_by_contractor_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "milestone"
        verbose_name = "этап"
        verbose_name_plural = "этапы"
        ordering = ["contract_id", "order"]
        constraints = [
            models.CheckConstraint(
                condition=(
                    Q(amount__isnull=True, amount_currency__isnull=True)
                    | Q(amount__isnull=False, amount_currency__isnull=False)
                ),
                name="milestone_amount_currency_together",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.contract_id}:{self.title}"


class ChecklistItem(models.Model):
    """Пункт чек-листа — измеримый критерий приёмки, привязан к ЛИСТУ
    (domain-model.md §7.2). После подписания не редактируется (Э4.4 —
    заморозка версии; здесь никакой блокировки правки по этому признаку
    ещё нет, только по статусу согласования договора, см. services.py).

    `source_template` (ADR-153) — из какой РЕДАКЦИИ шаблонного пункта
    каталога сделан этот пункт (`null` — сторона написала критерий сама).
    Заполняется один раз при создании тем же сопоставлением по тексту, что
    двигает счётчик востребованности (`apps.catalog.services.
    record_checklist_pick`): собственного текста у пункта после создания
    никто не переписывает под шаблон, PATCH связь не пересчитывает —
    поле фиксирует ПРОИСХОЖДЕНИЕ, а не текущее совпадение. Ссылка ведёт на
    конкретную редакцию (`slug` + `version`, ADR-081), потому что именно её
    текст сторона видела в подсказке; агрегат по пункту берётся по
    `source_template.slug`."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    milestone = models.ForeignKey(
        Milestone, related_name="checklist_items", on_delete=models.CASCADE
    )
    # related_name="+": обратного аксессора у каталога нет намеренно —
    # apps.catalog нижний слой и про договоры не знает (CLAUDE.md).
    source_template = models.ForeignKey(
        "catalog.ChecklistTemplateItem",
        related_name="+",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
    )
    description = models.TextField()
    measurable_criterion = models.TextField()
    required_evidence = models.JSONField(default=list, blank=True)
    order = models.PositiveSmallIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "checklist_item"
        verbose_name = "пункт чек-листа"
        verbose_name_plural = "пункты чек-листа"
        ordering = ["milestone_id", "order"]

    def __str__(self) -> str:
        return self.description[:60]


class ContractMaterial(models.Model):
    """Материал в рамках договора (domain-model.md §7.3), привязан к ЛИСТУ.
    `catalog_item` обязателен (минимум «Прочее» сферы, apps.catalog.
    MaterialCatalogItem) — справочник ПОДСКАЗЫВАЕТ рекомендации чек-листа
    (ADR-047), не ограничивает единицы измерения. Правило цены (ADR-047,
    tech-spec.md §5.2.5): `unit_price=0` допустим ТОЛЬКО при
    `source=customer` (заказчик поставляет свой материал бесплатно для
    исполнителя) — CheckConstraint ниже.

    Срок поставки — УСЛОВИЕ, не дата (`delivery_days` + `delivery_base`,
    `DeliveryBase`): дата вычисляется от наступления события
    (`apps.milestones.services.delivery_deadline`), не хранится."""

    class Source(models.TextChoices):
        CONTRACTOR = "contractor", "Исполнитель"
        CUSTOMER = "customer", "Заказчик"

    class DeliveryBase(models.TextChoices):
        CONTRACT_SIGNING = "contract_signing", "Подписание договора"
        PREPAYMENT = "prepayment", "Предоплата"
        STAGE_START = "stage_start", "Начало этапа"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    milestone = models.ForeignKey(Milestone, related_name="materials", on_delete=models.CASCADE)
    catalog_item = models.ForeignKey(
        "catalog.MaterialCatalogItem", related_name="materials", on_delete=models.PROTECT
    )
    description = models.TextField()
    external_url = models.CharField(max_length=500, blank=True, default="")
    quantity = models.DecimalField(max_digits=12, decimal_places=3, default=0)
    unit = models.CharField(max_length=32, blank=True, default="")
    unit_price = models.DecimalField(max_digits=14, decimal_places=2)
    unit_price_currency = models.CharField(max_length=3)
    source = models.CharField(max_length=16, choices=Source.choices)
    delivery_days = models.PositiveIntegerField(default=0)
    delivery_base = models.CharField(
        max_length=32, choices=DeliveryBase.choices, default=DeliveryBase.CONTRACT_SIGNING
    )
    # ADR-155: передача материала — ДВА факта ДВУХ разных сторон, а не один
    # флаг «получено», который до этого мог поставить кто угодно (замечание
    # владельца 03.09: «с материалами тоже было 2х стороннее подтверждение
    # Материалы переданы — Материалы получены»). `handed_over_*` ставит
    # СТОРОНА-ИСТОЧНИК (`source`), `received*` — другая сторона.
    # ПОРЯДОК НЕ ОБЯЗАТЕЛЕН (уточнение владельца 03.09: «Исполнитель может в
    # одностороннем порядке поставить "получены". Сделаем жизнь людям чуть
    # легче») — «передано» остаётся необязательным сигналом источника, и
    # CHECK «получено ⇒ передано» поэтому не заводится. Что нельзя —
    # подтверждать получение ЗА СЕБЯ: это по-прежнему проверяет
    # `services.confirm_material_received` (403).
    # Метки времени, а не булев `handed_over`: «когда» дороже «да/нет»
    # (тот же приём, что `Payment.payer_confirmed_at`) — `received`
    # остаётся булевым, потому что на него уже смотрят гейт и фронт.
    handed_over_at = models.DateTimeField(null=True, blank=True)
    handed_over_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        related_name="+",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
    )
    received = models.BooleanField(default=False)
    received_at = models.DateTimeField(null=True, blank=True)
    received_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        related_name="+",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "contract_material"
        verbose_name = "материал договора"
        verbose_name_plural = "материалы договора"
        ordering = ["milestone_id", "created_at"]
        constraints = [
            # Значения Source не видны из области Meta (вложенный класс) —
            # литерал дублирует choices намеренно (тот же приём, что
            # apps.contracts.models.ContractParty.Meta).
            models.CheckConstraint(
                condition=Q(source="customer") | Q(unit_price__gt=0),
                name="contract_material_price_rule",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.milestone_id}:{self.description[:40]}"
