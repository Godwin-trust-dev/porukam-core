"""tech-spec.md §2.5, §5.2.10 (notification, delivery_attempt); docs/tasks/
fundament.md ЭФ.4; domain-model.md §17; docs/adr/ADR-057-notification-cabinet-channel.md.

Юридический момент доставки — РАЗМЕЩЕНИЕ В ЛИЧНОМ КАБИНЕТЕ (`placed_in_cabinet_at`),
не push/email/sms (те — дублирующие каналы, ADR-057). apps.notifications.services.
place_notification() пишет эту строку и, если у субъекта уведомления есть
незаякоренный DomainDeadline(starts_from=cabinet_placement), якорит его тем же
моментом (связка с ЭФ.2).

`template`/`related_deadline.kind` — ссылки ПО ЗНАЧЕНИЮ, не FK на модель
другого приложения (CLAUDE.md: приложения общаются через services.py-фасады,
не через прямой импорт чужих моделей) — тот же приём, что у DomainDeadline.kind
относительно DeadlineKindConfig (apps/deadlines/models.py). `related_deadline`
— явное исключение: сама схема tech-spec.md §5.2.10 требует FK на
domain_deadline, поэтому используем ссылку по строке "app_label.Model"
(app_label указывается по label, не по AppConfig.name — apps.deadlines
зарегистрировано с label="deadlines"), не импортируя класс модели."""

from __future__ import annotations

from django.conf import settings
from django.db import models

from common.uuid7 import uuid7


class NotificationTemplate(models.Model):
    """Шаблон-болванка (CLAUDE.md/fundament.md ЭФ.4: тексты уведомлений
    «начисто» — не в рамках фундамента, формулировки придут от юриста).
    `legal_significance` копируется в Notification.legal_significance в
    момент создания (tech-spec.md §5.2.10 держит это отдельной колонкой на
    самой записи, а не производной от шаблона задним числом).

    body_i18n (ГВ.5, docs/tasks/global-wave.md, ADR-075) — {"ru": "...",
    "en": "..."} вместо одноязычного body_stub (миграция 0003 переносит
    существующий текст в body_i18n["ru"]): язык резолвится per-получатель
    (apps.notifications.services.place_notification, apps.jurisdictions.
    selectors.resolve_locale по User.country_code), не хранится статично на
    шаблоне. Тот же приём, что apps.catalog.*.name_i18n."""

    code = models.CharField(max_length=64, primary_key=True)
    legal_significance = models.BooleanField(default=False)
    body_i18n = models.JSONField(default=dict)

    class Meta:
        db_table = "notification_template"
        verbose_name = "шаблон уведомления"
        verbose_name_plural = "шаблоны уведомлений"

    def __str__(self) -> str:
        return self.code


class ReminderPointConfig(models.Model):
    """Серия напоминаний по точкам (domain-model.md §17 acceptance_reminders):
    точки — ДАННЫЕ конфигурации (docs/tasks/fundament.md ЭФ.4), не константы в
    коде. `kind` — ссылается по значению на DomainDeadline.kind (apps.deadlines):
    серия напоминаний привязана к дедлайну, для которого их пришлось делать.
    `points` — доли [0.0..1.0) пройденного интервала anchor_at..deadline_at;
    точка 0.0 не используется здесь — она уже покрыта самим place_notification
    в момент якорения."""

    kind = models.CharField(max_length=64, primary_key=True)
    template = models.CharField(max_length=64)
    points = models.JSONField(default=list)

    class Meta:
        db_table = "reminder_point_config"
        verbose_name = "серия напоминаний"
        verbose_name_plural = "серии напоминаний"

    def __str__(self) -> str:
        return f"{self.kind}: {self.points}"


class Notification(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    recipient = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="notifications", on_delete=models.CASCADE
    )
    # По значению — код NotificationTemplate (см. докстринг модуля).
    template = models.CharField(max_length=64)
    payload = models.JSONField(default=dict)
    # ADR-098: субъект события (по значению, без FK — субъект может жить в
    # любом приложении) + денормализованный якорь навигации: тап по пункту
    # ленты ведёт на договор (DEV-14 §3). contract_id заполняется из
    # subject.contract_id события либо из subject.id при type="contract";
    # None — у события нет договора (entity_claimed) или уведомление
    # размещено до ADR-098.
    subject_type = models.CharField(max_length=32, blank=True, default="")
    subject_id = models.UUIDField(null=True, blank=True)
    contract_id = models.UUIDField(null=True, blank=True)
    # ADR-126: common.models.OutboxEvent.event_id, из которого уведомление
    # родилось (по значению, без FK — outbox живёт в common и чистится
    # отдельно). Ключ дедупликации повторной доставки (ADR-064: реле
    # переотдаёт событие ВСЕМ подписчикам темы, если упал хоть один).
    # NULL — «прямые» place_notification из services.py, они не от события.
    source_event_id = models.UUIDField(null=True, blank=True)
    legal_significance = models.BooleanField(default=False)

    placed_in_cabinet_at = models.DateTimeField(null=True, blank=True)
    content_hash = models.CharField(max_length=64, blank=True, default="")
    read_at = models.DateTimeField(null=True, blank=True)

    push_sent_at = models.DateTimeField(null=True, blank=True)
    email_sent_at = models.DateTimeField(null=True, blank=True)
    sms_sent_at = models.DateTimeField(null=True, blank=True)

    delivered_at = models.DateTimeField(null=True, blank=True)
    delivered_via = models.CharField(max_length=16, blank=True, default="")

    related_deadline = models.ForeignKey(
        "deadlines.DomainDeadline",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="notifications",
    )

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "notification"
        verbose_name = "уведомление"
        verbose_name_plural = "уведомления"
        constraints = [
            # ADR-126: одно уведомление на (получатель, шаблон, событие) —
            # вторая линия защиты идемпотентности подписчика
            # (apps.notifications.subscriber._place делает предпроверку).
            # Условие по NULL: «прямые» вызовы place_notification без
            # события не должны схлопываться между собой.
            models.UniqueConstraint(
                fields=["recipient", "template", "source_event_id"],
                condition=models.Q(source_event_id__isnull=False),
                name="unique_notification_per_source_event",
            ),
        ]
        indexes = [
            models.Index(fields=["recipient", "-created_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.template} -> {self.recipient_id}"


class DeliveryAttempt(models.Model):
    class Channel(models.TextChoices):
        IN_APP = "in_app", "Личный кабинет"
        PUSH = "push", "Push"
        EMAIL = "email", "Email"
        SMS = "sms", "SMS"

    id = models.BigAutoField(primary_key=True)
    notification = models.ForeignKey(
        Notification, related_name="delivery_attempts", on_delete=models.CASCADE
    )
    channel = models.CharField(max_length=16, choices=Channel.choices)
    provider_message_id = models.CharField(max_length=128, blank=True, default="")
    status = models.CharField(max_length=32)
    status_at = models.DateTimeField()

    class Meta:
        db_table = "delivery_attempt"
        verbose_name = "попытка доставки"
        verbose_name_plural = "попытки доставки"

    def __str__(self) -> str:
        return f"{self.notification_id}:{self.channel}:{self.status}"


class ReminderSchedule(models.Model):
    """Запланированная точка серии напоминаний конкретного дедлайна
    (создаётся services.schedule_reminder_series при якорении). Sweep
    (apps.notifications.tasks.sweep_reminder_schedules) выбирает просроченные
    и невыполненные (fired_at IS NULL) и шлёт напоминание."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    deadline = models.ForeignKey(
        "deadlines.DomainDeadline", related_name="reminder_schedules", on_delete=models.CASCADE
    )
    recipient = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="reminder_schedules", on_delete=models.CASCADE
    )
    # По значению — код NotificationTemplate.
    template = models.CharField(max_length=64)
    point = models.FloatField()
    # domain-model.md §17: финальная точка серии — единственная, для которой
    # предусмотрена fallback-SMS (ADR-057), если push не доставлен.
    is_final = models.BooleanField(default=False)

    fire_at = models.DateTimeField()
    fired_at = models.DateTimeField(null=True, blank=True)
    notification = models.ForeignKey(
        Notification,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="reminder_schedule_entries",
    )

    class Meta:
        db_table = "reminder_schedule"
        verbose_name = "запланированное напоминание"
        verbose_name_plural = "запланированные напоминания"
        constraints = [
            # ADR-138: серия «договор без движения» адресуется ОБЕИМ сторонам
            # (у `milestone_acceptance` получатель один — заказчик), поэтому
            # точка уникальна на пару (дедлайн, получатель), не на дедлайн.
            models.UniqueConstraint(
                fields=["deadline", "recipient", "point"], name="unique_reminder_point"
            ),
        ]
        indexes = [
            models.Index(
                fields=["fire_at"],
                name="reminder_schedule_due_idx",
                condition=models.Q(fired_at__isnull=True),
            ),
        ]

    def __str__(self) -> str:
        return f"{self.deadline_id}@{self.point}"


class NotificationSettings(models.Model):
    """GET/PUT /notification-settings (tech-spec.md §5.2.10, fundament.md
    ЭФ.4). `in_app_enabled` присутствует полем (не константой в коде), но
    CheckConstraint гарантирует на уровне БД, что он не может стать False —
    ЛК-канал отключить нельзя (CLAUDE.md, domain-model.md §17).

    Группы-каналы (deals/chats/payments/deadlines/disputes — контракт фронта
    DEV-14 §7, №10 отсмотра 2026-08-18): выключенная группа глушит
    push/email-ДОСТАВКУ уведомлений этой группы (place_notification), но НЕ
    ленту ЛК — размещение в кабинете юрзначимо и от групп не зависит.

    `push_permission` — последнее отрапортованное фронтом состояние
    браузерного разрешения (default/granted/denied). Технически оно
    per-устройство; храним последнее известное (как мок): его читает лента
    (промо-полоса push) и защита PUT push=true при denied
    (422 push_permission_denied)."""

    class PushPermission(models.TextChoices):
        DEFAULT = "default"
        GRANTED = "granted"
        DENIED = "denied"

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, related_name="notification_settings", on_delete=models.CASCADE
    )
    in_app_enabled = models.BooleanField(default=True)
    push_enabled = models.BooleanField(default=True)
    # Решение продукта 25.08: e-mail-канал по умолчанию ВЫКЛЮЧЕН — дублировать
    # каждое уведомление письмом человек должен включить сам (мок фронта
    # web/src/mocks/notificationsDb.ts жил с `email: false` с самого начала,
    # расходился именно бэкенд). Только дефолт для НОВЫХ строк: миграция 0015
    # — AlterField, существующие настройки не трогает.
    email_enabled = models.BooleanField(default=False)
    sms_enabled = models.BooleanField(default=True)
    push_permission = models.CharField(
        max_length=8, choices=PushPermission.choices, default=PushPermission.DEFAULT
    )
    group_deals = models.BooleanField(default=True)
    # Складка «Чаты» (отсмотр 2026-08-24): сообщения переписки — отдельная группа.
    group_chats = models.BooleanField(default=True)
    group_payments = models.BooleanField(default=True)
    group_deadlines = models.BooleanField(default=True)
    group_disputes = models.BooleanField(default=True)

    class Meta:
        db_table = "notification_settings"
        verbose_name = "настройки уведомлений"
        verbose_name_plural = "настройки уведомлений"
        constraints = [
            models.CheckConstraint(
                condition=models.Q(in_app_enabled=True),
                name="notification_settings_in_app_always_enabled",
            ),
        ]

    def __str__(self) -> str:
        return f"настройки {self.user_id}"


class PushSubscription(models.Model):
    """Web Push подписка браузера (ADR-110): endpoint + ключи из
    `PushManager.subscribe()`. Дублирующий канал (ADR-057: юрканал — ЛК,
    `placed_in_cabinet_at`), поэтому мягкие правила жизни: подписка удаляется
    при 404/410 от push-сервиса (браузер её отозвал) и переписывается на
    нового пользователя при повторной подписке того же браузера (endpoint
    уникален у браузера, не у пользователя). НЕ `accounts.UserDevice`:
    тот — модель фейк-эры с `push_token` (FCM-стиль, 255 символов), Web Push
    несёт endpoint-URL ~500 символов + пару ключей и живёт в контексте
    канала уведомлений."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="push_subscriptions", on_delete=models.CASCADE
    )
    endpoint = models.TextField(unique=True)
    # Ключи шифрования полезной нагрузки (RFC 8291): приходят от браузера
    # base64url-строками, хранятся как есть — приватного материала тут нет.
    p256dh = models.CharField(max_length=255)
    auth = models.CharField(max_length=255)
    user_agent = models.CharField(max_length=255, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "push_subscription"
        verbose_name = "web push подписка"
        verbose_name_plural = "web push подписки"

    def __str__(self) -> str:
        return f"{self.user_id}:{self.endpoint[:40]}"


class DeviceToken(models.Model):
    """Токен нативного пуш-провайдера мобильной обёртки (ADR-176): RuStore
    Push, FCM или HMS Push Kit. Второй канал «звонка в дверь» рядом с
    `PushSubscription` (Web Push, ADR-110); юрканал по-прежнему ЛК
    (`placed_in_cabinet_at`, ADR-057).

    Почему отдельная модель, а не `accounts.UserDevice.push_token`: тот —
    модель фейк-эры (ADR-110 п.1) и чужой bounded context; тянуть ради канала
    уведомлений зависимость notifications → accounts сверх фасада не нужно.

    Правила жизни те же, что у Web Push подписки: `token` уникален у
    УСТРОЙСТВА, а не у пользователя — вошёл в приложение другой аккаунт,
    строка переписывается на него (иначе пуши уходили бы прежнему владельцу
    телефона); ответ провайдера «токен невалиден/unregistered» удаляет строку
    по месту, отдельного sweep нет.

    `app_id` — applicationId сборки обёртки: у Play- и RuStore-сборки они
    разные (`docs/ops/stores-other.md` §2.4), и по нему видно, из какого
    магазина устройство. `platform` — задел на iOS/HarmonyOS, сегодня всегда
    "android"."""

    class Provider(models.TextChoices):
        RUSTORE = "rustore", "RuStore Push"
        FCM = "fcm", "Firebase Cloud Messaging"
        HMS = "hms", "Huawei Push Kit"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="device_tokens", on_delete=models.CASCADE
    )
    provider = models.CharField(max_length=16, choices=Provider.choices)
    # TextField, как endpoint у PushSubscription: длина токена у провайдеров
    # не нормирована (FCM ~160+, RuStore/HMS свои), обрезать нельзя — обрезанный
    # токен молча не доставляет.
    token = models.TextField(unique=True)
    app_id = models.CharField(max_length=128)
    platform = models.CharField(max_length=16, default="android")
    user_agent = models.CharField(max_length=255, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    # Обновляется при каждой перерегистрации токена (обёртка шлёт его при
    # каждом запуске): видно, живо ли устройство, без отдельного пинга.
    last_seen_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "device_token"
        verbose_name = "токен устройства"
        verbose_name_plural = "токены устройств"
        indexes = [models.Index(fields=["user"], name="device_token_user_idx")]

    def __str__(self) -> str:
        return f"{self.user_id}:{self.provider}:{self.token[:24]}"


# ADR-156: код шаблона схлопнутого уведомления о правках материалов этапа в
# согласовании. Живёт в models.py, потому что его читают ВСЕ три слоя
# приложения (services — размещение, selectors — проекция ленты, subscriber —
# ничего лишнего не импортируя друг у друга), а также миграция-сидер 0027.
MATERIALS_CHANGED_TEMPLATE = "contract.materials_changed"


class PendingMaterialsChange(models.Model):
    """Одна правка материалов этапа, ЖДУЩАЯ схлопывания в общую карточку
    (ADR-156). Строка в БД + минутный sweep (`apps.notifications.tasks.
    sweep_materials_change_digests`), а НЕ отложенная на N минут Celery-задача
    — то же правило, что у доменных дедлайнов и серий напоминаний (CLAUDE.md:
    «дедлайны — строки в БД + sweep каждую минуту»): отложенная задача
    теряется при сбое брокера, строка — нет.

    Зачем окно вообще: ADR-155 разрешил править материалы прямо в
    согласовании (`_assert_editable` пускает draft и under_review), и человек
    правит их ПАЧКОЙ — переписал цену, добавил две позиции, одну убрал. Без
    схлопывания вторая сторона получила бы столько же уведомлений, сколько
    было кликов, и перестала бы их читать.

    Ключ окна — (получатель, договор, ЭТАП, актор). Этап в ключе, потому что
    текст карточки называет этап (`«{milestone_title}»`): правки двух разных
    этапов — два разных факта для читателя, и одной карточкой их честно не
    описать. В типичном случае (правят один этап) это ровно то же самое, что
    окно на договор.

    Идемпотентность повторной доставки события (ADR-064 at-least-once) — на
    UniqueConstraint (recipient, source_event_id), тем же вторым эшелоном, что
    у Notification: предпроверка в services.register_materials_change +
    IntegrityError на гонке. Строки НЕ удаляются после отправки
    (`notified_at`/`notification` проставляются на месте) — иначе повторная
    доставка события, чьё окно уже закрылось, завела бы новое окно и вторую
    карточку об одних и тех же правках."""

    class Change(models.TextChoices):
        ADDED = "added", "Добавлен"
        UPDATED = "updated", "Изменён"
        REMOVED = "removed", "Удалён"

    id = models.BigAutoField(primary_key=True)
    recipient = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        related_name="pending_materials_changes",
        on_delete=models.CASCADE,
    )
    # Ссылки ПО ЗНАЧЕНИЮ (CLAUDE.md: чужие модели не импортируем) — тот же
    # приём, что у Notification.contract_id/subject_id.
    contract_id = models.UUIDField()
    milestone_id = models.UUIDField()
    milestone_title = models.CharField(max_length=300, blank=True, default="")
    actor_id = models.UUIDField()
    change = models.CharField(max_length=16, choices=Change.choices)
    source_event_id = models.UUIDField()

    # Момент закрытия окна: у первой правки окна — now + окно, у всех
    # последующих правок ТОГО ЖЕ окна — ровно то же значение (окно не
    # «едет» от каждой новой правки, иначе непрерывно правящая сторона
    # оттягивала бы уведомление бесконечно).
    notify_at = models.DateTimeField()
    notified_at = models.DateTimeField(null=True, blank=True)
    notification = models.ForeignKey(
        Notification,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="materials_changes",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "pending_materials_change"
        verbose_name = "правка материалов в ожидании уведомления"
        verbose_name_plural = "правки материалов в ожидании уведомления"
        constraints = [
            models.UniqueConstraint(
                fields=["recipient", "source_event_id"],
                name="unique_materials_change_per_source_event",
            ),
        ]
        indexes = [
            models.Index(
                fields=["notify_at"],
                name="materials_change_due_idx",
                condition=models.Q(notified_at__isnull=True),
            ),
        ]

    def __str__(self) -> str:
        return f"{self.change}:{self.milestone_id} -> {self.recipient_id}"
