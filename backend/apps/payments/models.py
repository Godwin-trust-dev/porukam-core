"""Э5 «Деньги», волна 1 — ПРЯМОЙ платёж с двусторонним подтверждением
(tech-spec.md §5.2.6 `payment`, §6.3 «финансовое условие гейта», §8.7;
docs/plan.md «Этап 5»; ADR-130).

Что здесь ЕСТЬ: `Payment` — юридический факт «к оплате выставлено /
плательщик отметил / получатель подтвердил / оплачено», без единого рубля
через платформу (финмодель v2, док 28: комиссии нет, `contract_fee: null`,
платформа денег не держит и не берёт процент).

Чего здесь НЕТ и почему: эквайринг, СБП-сплит, холд/эскроу, возвраты,
`PayoutAccount`, `ProviderRoute`, обе «раскладки до подтверждения»
(`payer_breakdown`/`payee_breakdown`), `operator_fee_*` — всё это требует
ДОГОВОРА С ПЛАТЁЖНЫМ ПАРТНЁРОМ, которого нет (tech-spec.md §15.5: партнёр
№1 Т-Банк, №2 ЮKassa — внешний трек). Способы `direct_platform`/`hold`
объявлены значениями (контракт API закладывается сразу, чтобы клиенты не
менялись — tech-spec.md §8.7), но создание платежа с ними отбивается
`PaymentProviderNotConfiguredError` -> `409 payment_provider_not_configured`:
ЧЕСТНАЯ заглушка, не имитация успеха (тот же принцип, что
`apps.milestones.services._financial_condition` держал до Э5).

Статусы провайдерской эры (`processing/held/captured/voided/refunded/
failed/observed/disputed`) перечислены в `Status` и разрешены CHECK-
констрейнтом СРАЗУ — схема §5.2.6 их требует, и заводить их отдельной
миграцией в момент подключения партнёра значило бы менять CHECK на живой
таблице платежей. Переходов в них в `PAYMENT_FSM` НЕТ (см. services.py) —
недостижимы по построению, а не «забыты».

Направление зависимости (ADR-130): `apps.payments` импортирует
`apps.milestones`/`apps.contracts`, ОБРАТНОГО импорта нет и быть не может —
`apps.contracts.services` статически достаёт до `apps.milestones.services`,
поэтому `apps.milestones -> apps.payments` сломал бы контракт import-linter
«contracts не импортирует payments» ТРАНЗИТИВНО. FK на чужие модели —
строкой (`"contracts.Contract"`), тем же приёмом, что `apps.disputes.models.
Dispute`: запрет CLAUDE.md — на импорт чужих МОДУЛЕЙ ради бизнес-логики,
не на ссылочную целостность в БД.
"""

from __future__ import annotations

from django.db import models
from django.db.models import Q

from common.uuid7 import uuid7


class Payment(models.Model):
    """Платёж по денежному ЛИСТУ дерева этапов (tech-spec.md §5.2.6:
    `payment(contract_id, milestone_id, kind, method, amount, currency,
    status, confirmed_by_payer, confirmed_by_payee, provider,
    provider_operation_id, ...)`).

    Всегда на лист, а не на договор: «ветки группируют, ЛИСТЬЯ
    принимаются/оплачиваются» (CLAUDE.md, domain-model.md §7.1) — сумма
    есть только у листа (`milestone_amount_guard`), значит и платить можно
    только за лист.

    `confirmed_by_payer`/`confirmed_by_payee` спеки представлены МЕТКАМИ
    ВРЕМЕНИ (`payer_confirmed_at`/`payee_confirmed_at`), а не bool: юрканал
    считает сроки от моментов, а не от флагов (ADR-057), и «когда» дороже,
    чем «да/нет». Булевы поля отдаются наружу как производные
    (`apps.payments.selectors.payment_view`), контракт API §8.7 не страдает.

    Комиссии платформы нет НИ ОДНИМ полем (финмодель v2, док 28) — не
    «ноль в колонке», а отсутствие сущности: `platform_commission_amount`
    §5.2.6 не заводится, чтобы не появилось места, куда её однажды впишут.
    """

    class Kind(models.TextChoices):
        #: ЕДИНСТВЕННЫЙ платёж по денежному листу. Когда его платят,
        #: решает `Contract.payment_order` (ADR-151/155), а не вид: при
        #: `after_acceptance` — после приёмки, при `before_start` — до
        #: старта листа. Вид `advance` упразднён вместе со способом
        #: `payment_method=prepayment` (ADR-155, владелец 03.09): он был
        #: вторым именем той же оплаты того же листа, и «аванс + постоплата»
        #: означало бы заплатить дважды.
        POSTPAYMENT = "postpayment", "Оплата этапа"
        # Зарезервированы схемой §5.2.6, в этой волне не создаются:
        # `prepayment` — частичная предоплата (сумма МЕНЬШЕ суммы листа,
        # которой домен пока не знает), `refund` — возврат, он невозможен,
        # пока платформа не проводит деньги.
        PREPAYMENT = "prepayment", "Частичная предоплата (Р2)"
        REFUND = "refund", "Возврат (Р2)"

    class Method(models.TextChoices):
        """Зеркало `apps.contracts.models.Contract.PaymentMethod` — способ
        расчёта выбирается на договоре, платёж его наследует и хранит
        СВОЙ снимок (договор может быть изменён допником, уже выставленный
        платёж — нет)."""

        CASH = "cash", "Наличные"
        EXTERNAL = "external", "Внешний перевод"
        # Требуют платёжного партнёра — создание отбивается 409.
        DIRECT_PLATFORM = "direct_platform", "Прямой платёж (наблюдение платформой)"
        HOLD = "hold", "Холд (Р2)"

    #: Способы, работающие БЕЗ платёжного партнёра: платформа фиксирует
    #: факт по подтверждению обеих сторон, деньги идут мимо неё.
    TWO_SIDED_METHODS = frozenset({Method.CASH, Method.EXTERNAL})
    #: Способы, требующие провайдера (партнёра нет — ADR-130).
    PROVIDER_METHODS = frozenset({Method.DIRECT_PLATFORM, Method.HOLD})

    class Status(models.TextChoices):
        PENDING = "pending", "Выставлен к оплате"
        PAYER_CONFIRMED = "payer_confirmed", "Плательщик отметил оплату"
        PAYEE_CONFIRMED = "payee_confirmed", "Получатель подтвердил получение"
        CONFIRMED = "confirmed", "Оплачен (подтвердили обе стороны)"
        CANCELLED = "cancelled", "Отменён"
        # --- Провайдерская эра (§5.2.6), недостижимы в этой волне ---------
        PROCESSING = "processing", "В обработке провайдером"
        HELD = "held", "Захолдирован"
        CAPTURED = "captured", "Списан с холда"
        VOIDED = "voided", "Холд снят"
        REFUNDED = "refunded", "Возвращён"
        DISPUTED = "disputed", "Расхождение сторон"
        FAILED = "failed", "Провайдер отклонил"
        OBSERVED = "observed", "Прямой платёж наблюдён платформой"

    #: Терминальные для этой волны — из них нет ни одного перехода.
    TERMINAL_STATUSES = frozenset({Status.CONFIRMED, Status.CANCELLED})

    #: Единственный «провайдер» первой волны: его нет. Значение хранится
    #: явно (а не NULL), чтобы UNIQUE (provider, provider_ref) и
    #: маршрутизация ProviderRoute (Р2) не переписывались задним числом.
    PROVIDER_MANUAL = "manual"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)

    contract = models.ForeignKey(
        "contracts.Contract", related_name="payments", on_delete=models.CASCADE
    )
    milestone = models.ForeignKey(
        "milestones.Milestone", related_name="payments", on_delete=models.CASCADE
    )

    kind = models.CharField(max_length=16, choices=Kind.choices)
    method = models.CharField(max_length=16, choices=Method.choices)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)

    # Деньги — ВСЕГДА пара (CLAUDE.md): валюты по умолчанию нет, обе
    # колонки NOT NULL (в отличие от Milestone.amount, где NULL у ветки —
    # валидное состояние: платежа у ветки не бывает вообще).
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    currency = models.CharField(max_length=3)

    payer_confirmed_at = models.DateTimeField(null=True, blank=True)
    payee_confirmed_at = models.DateTimeField(null=True, blank=True)
    cancelled_at = models.DateTimeField(null=True, blank=True)
    cancel_reason = models.CharField(max_length=255, blank=True, default="")
    # Просрочка — НЕ статус: платёж остаётся `pending` и подлежит оплате,
    # просто срок вышел (событие `payment.overdue`, свип дедлайнов).
    # Отдельным статусом она сделала бы «просрочен» несовместимым с
    # «оплачен позже», чего домен не хочет.
    overdue_at = models.DateTimeField(null=True, blank=True)

    provider = models.CharField(max_length=32, default=PROVIDER_MANUAL)
    # `provider_operation_id` схемы §5.2.6 — здесь `provider_ref`: имя из
    # tech-spec.md §8.7 контракта не касается (наружу поле не отдаётся под
    # старым именем ни в одном ответе), а `_ref` честнее для значения,
    # которое у одних партнёров операция, у других — платёжная сессия.
    provider_ref = models.CharField(max_length=128, null=True, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "payment"
        verbose_name = "платёж"
        verbose_name_plural = "платежи"
        ordering = ["created_at", "id"]
        constraints = [
            # Идемпотентность ВЫСТАВЛЕНИЯ (а не HTTP-запроса, тот закрыт
            # Idempotency-Key в api/): на лист приходится ровно один
            # платёж каждого вида. Именно этот UNIQUE делает безопасным
            # повторную доставку события реле (ADR-064, at-least-once) —
            # подписчик apps.payments.handlers не ведёт своей таблицы
            # обработанных событий, ему хватает ограничения БД.
            models.UniqueConstraint(
                fields=["milestone", "kind"], name="payment_unique_milestone_kind"
            ),
            models.CheckConstraint(condition=Q(amount__gt=0), name="payment_amount_positive"),
            # ISO 4217 — ровно три заглавные латинские буквы. Проверка в БД,
            # а не только в сериализаторе: строку может создать миграция
            # данных или ручной INSERT в инциденте.
            models.CheckConstraint(
                condition=Q(currency__regex=r"^[A-Z]{3}$"), name="payment_currency_iso4217"
            ),
            models.CheckConstraint(
                condition=Q(
                    status__in=[
                        "pending",
                        "payer_confirmed",
                        "payee_confirmed",
                        "confirmed",
                        "cancelled",
                        "processing",
                        "held",
                        "captured",
                        "voided",
                        "refunded",
                        "disputed",
                        "failed",
                        "observed",
                    ]
                ),
                name="payment_status_valid",
            ),
            # ADR-155 сузил `Kind`/`Method` (упразднены вид `advance` и
            # способ `prepayment`), а СПИСКИ В CHECK оставил прежними
            # намеренно: констрейнт разрешает НАДМНОЖЕСТВО — сужать его на
            # живой таблице платежей значило бы ALTER ради значений, которые
            # код всё равно больше не создаёт, и отвергать исторические
            # строки, если они где-то есть.
            models.CheckConstraint(
                condition=Q(kind__in=["advance", "postpayment", "prepayment", "refund"]),
                name="payment_kind_valid",
            ),
            models.CheckConstraint(
                condition=Q(
                    method__in=["prepayment", "cash", "external", "direct_platform", "hold"]
                ),
                name="payment_method_valid",
            ),
            # §5.2.6: UNIQUE (provider, provider_operation_id). Условный —
            # у платежа без провайдера ref пустой, и NULL в UNIQUE не
            # схлопываются только в PostgreSQL; условие делает это явным.
            models.UniqueConstraint(
                fields=["provider", "provider_ref"],
                condition=Q(provider_ref__isnull=False),
                name="payment_unique_provider_ref",
            ),
        ]
        indexes = [
            models.Index(fields=["contract", "status"], name="payment_contract_status_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.kind}:{self.milestone_id} {self.amount} {self.currency} ({self.status})"


class ProviderWebhookEvent(models.Model):
    """Идемпотентность вебхуков (CLAUDE.md: «вебхуки идемпотентны»).

    Партнёры переотправляют вебхук, пока не получат 2xx, и переотправляют
    ПОСЛЕ того, как уже получили 2xx (сетевой обрыв на ответе) — поэтому
    защита строится не на «мы ответили», а на UNIQUE (provider, event_id).
    Строка создаётся ДО применения эффекта в той же транзакции: гонка двух
    одновременных доставок падает на IntegrityError, а не удваивает платёж.

    Таблица заводится сейчас, хотя единственный зарегистрированный
    провайдер (`manual`) вебхуков не шлёт: контракт эндпоинта
    `POST /v1/payments/webhooks/{provider}` и его идемпотентность — это то,
    что нельзя «добавить потом» (ADR-130), а тест на повтор без таблицы
    было бы нечем написать.
    """

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    provider = models.CharField(max_length=32)
    event_id = models.CharField(max_length=128)
    payload = models.JSONField(default=dict, blank=True)
    payment = models.ForeignKey(
        Payment, related_name="webhook_events", null=True, blank=True, on_delete=models.SET_NULL
    )
    outcome = models.CharField(max_length=32, blank=True, default="")
    received_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "provider_webhook_event"
        verbose_name = "вебхук платёжного провайдера"
        verbose_name_plural = "вебхуки платёжных провайдеров"
        constraints = [
            models.UniqueConstraint(
                fields=["provider", "event_id"], name="provider_webhook_unique_event"
            ),
            models.CheckConstraint(
                condition=Q(event_id__gt=""), name="provider_webhook_event_id_not_blank"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.provider}:{self.event_id}"
