"""tech-spec.md §4 (`evidence` — "Доказательства, офлайн-пакеты, экспорт,
хранение"); domain-model.md §14. ГВ.3 (docs/tasks/global-wave.md): этап 6
плана, поднятый над Э5 в GLOBAL-режиме — `services/evidence_ingest`
(services/evidence_ingest/pipeline.py, чистый пайплайн без Django) считает
хеш/миниатюру/метаданные, ЭТА модель хранит результат + оркестрацию релея/
бэкапа. Э6 (ADR-136, docs/adr/ADR-136-evidence-etap6-foundation.md): поля
манифеста DeviceKey (§5.2.8), шифрование оригиналов at rest, RetentionTimer
(ADR-036), окно выгрузки 72 ч / `lateness` (ADR-053). Полный офлайн-контур
(подпись DeviceKey с телефона, делегированная съёмка) — Р1-мобайл (Э10):
серверная половина здесь, включение — `EVIDENCE_DEVICE_MANIFEST_ENABLED`.

`milestone`/`checklist_item`/`dispute`/`device_key`/`assignment` — FK
СТРОКОЙ ("app_label.Model"), не прямой импорт (тот же приём, что
apps.documents.models — apps.evidence регистрируется в INSTALLED_APPS после
apps.milestones/apps.disputes, строковый FK разрешается лениво реестром
приложений Django, порядок регистрации на это не влияет)."""

from __future__ import annotations

from datetime import timedelta

from django.conf import settings
from django.db import models
from django.db.models import Q

from common.uuid7 import uuid7


class Evidence(models.Model):
    """Один файл-доказательство. `file_hash`/`thumbnail`/`metadata` —
    результат `services/evidence_ingest/pipeline.ingest()`: хеш считается
    ОТ ОЧИЩЕННЫХ байт (EXIF вырезан для JPEG, ADR-045) — то же содержимое,
    что уходит в релей контрагенту, поэтому «сверка предъявленного файла с
    хешом» (`services.verify_hash`) сравнивает на равных. Хеш — ВСЕГДА от
    открытых байт, не от шифротекста (ADR-136): то, что получил контрагент.

    `storage_mode` фиксируется НА МОМЕНТ ЗАГРУЗКИ (per-контур,
    `JurisdictionConfig.evidence_server_storage_enabled`, ГВ.1/ГВ.3) — не
    пересчитывается заново при каждом обращении: смена конфигурации контура
    после загрузки не должна задним числом менять судьбу уже принятого
    файла.

    GLOBAL (`storage_mode=global`, путь ГВ.3 — с 26.08 выключен данными
    jurisdictions/0009, код жив ради обратимости): `transit_payload` держит
    очищенные байты ВРЕМЕННО — до `delivered_to_counterparty_at`, затем
    очищается в NULL (в S3 в этом режиме не пишем никогда). Серверное
    хранение (`storage_mode=server`; `ru` — те же строки до ADR-136):
    `s3_object_key` — постоянное хранение (`apps.evidence.storage`, WORM по
    `WORM_MODE`), тело объекта — ШИФРОТЕКСТ конверта `common.crypto`
    (субъект `("evidence", id)`, `encryption_key_ref` — SubjectKey; пустая
    строка = объект, загруженный до ADR-136 и ещё не перешифрованный
    командой `evidence_encrypt_backfill`). Удаление оригинала по сроку =
    уничтожение ключа (`retention_state=shredded`), объект в WORM-бакете
    остаётся нечитаемым шифротекстом; строка НЕ удаляется никогда, хеш и
    миниатюра остаются (ADR-036, tech-spec.md §5.2.8).

    `lateness` (ADR-053, окно `evidence_upload_window` в DeadlineKindConfig):
    `unknown` — время съёмки неизвестно (веб-загрузка без манифеста, честно
    не «on_time»); `on_time`/`late` — по разнице «получено − снято по часам
    устройства»; `after_acceptance` — этап уже принят на момент загрузки:
    принимается в архив спора, на приёмку не влияет.

    `geo` (манифест DeviceKey) хранится ТОЛЬКО шифротекстом
    (`geo_encrypted`/`geo_key_ref`, субъект `("contract", contract_id)`):
    по ADR-045 геометка доказательства = адрес квартиры заказчика, то есть
    ПД; в API наружу — только факт наличия (`has_geo`)."""

    class StorageMode(models.TextChoices):
        # ГВ.3: `global` — оригинал у сторон (transit_payload до доставки),
        # `ru` — серверное хранение RU-контура. ADR-136 «Отмена части
        # ГВ.3»: серверное хранение во ВСЕХ контурах — новые загрузки
        # получают `server`; `ru` остаётся у старых строк (тот же путь
        # чтения, `services._SERVER_MODES`), `global` — только у строк,
        # загруженных до 26.08 либо при выключенном флаге контура.
        GLOBAL = "global", "GLOBAL (без хранения оригинала, до ADR-136)"
        RU = "ru", "RU (серверное хранение, до ADR-136)"
        SERVER = "server", "Серверное хранение (шифротекст, все контуры)"

    class DeliveryStatus(models.TextChoices):
        IN_TRANSIT = "in_transit", "В транзите"
        DELIVERED = "delivered", "Доставлено"

    class BackupStatus(models.TextChoices):
        NOT_REQUESTED = "not_requested", "Не запрошен"
        PENDING = "pending", "В процессе"
        COMPLETED = "completed", "Завершён"
        FAILED = "failed", "Ошибка"

    class Lateness(models.TextChoices):
        UNKNOWN = "unknown", "Время съёмки неизвестно"
        ON_TIME = "on_time", "В пределах окна выгрузки"
        LATE = "late", "Загружено с задержкой"
        AFTER_ACCEPTANCE = "after_acceptance", "После закрытия приёмки"

    class RetentionState(models.TextChoices):
        HOT = "hot", "Горячее хранение"
        ARCHIVED = "archived", "Архив"
        SHREDDED = "shredded", "Оригинал уничтожен (ключ)"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)

    contract = models.ForeignKey(
        "contracts.Contract", related_name="evidence_items", on_delete=models.CASCADE
    )
    milestone = models.ForeignKey(
        "milestones.Milestone",
        related_name="evidence_items",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
    )
    checklist_item = models.ForeignKey(
        "milestones.ChecklistItem",
        related_name="evidence_items",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
    )
    dispute = models.ForeignKey(
        "disputes.Dispute",
        related_name="evidence_items",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
    )
    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="uploaded_evidence", on_delete=models.PROTECT
    )

    # --- Манифест DeviceKey (tech-spec.md §5.2.8, ADR-053; Э10 заполняет) ---
    # PROTECT: ключ устройства и назначение — часть доказательной базы
    # («этот человек имел право быть на объекте, вот подпись его устройства»),
    # удалять их из-под доказательства нельзя.
    device_key = models.ForeignKey(
        "accounts.DeviceKey",
        related_name="evidence_items",
        null=True,
        blank=True,
        on_delete=models.PROTECT,
    )
    assignment = models.ForeignKey(
        "authority.ContractAssignment",
        related_name="evidence_items",
        null=True,
        blank=True,
        on_delete=models.PROTECT,
    )
    captured_at_device = models.DateTimeField(null=True, blank=True)
    device_clock_skew_ms = models.BigIntegerField(null=True, blank=True)
    geo_encrypted = models.BinaryField(null=True, blank=True)
    geo_key_ref = models.CharField(max_length=64, blank=True, default="")
    device_signature = models.BinaryField(null=True, blank=True)
    # RFC 3161-токен на ЭТОТ файл — nullable; по ADR-135 штампуется корень
    # суточного чекпойнта Audit Vault, не каждый файл; поле оставлено под
    # обратную привязку токена чекпойнта (заполняет audit_vault позже).
    tsa_token = models.BinaryField(null=True, blank=True)
    lateness = models.CharField(max_length=16, choices=Lateness.choices, default=Lateness.UNKNOWN)
    # False — не-доказательный файл (документы, `POST /contracts/{id}/evidence`
    # спеки, не реализован); веб-загрузки к этапу/спору — всегда True.
    is_evidence_role = models.BooleanField(default=True)

    file_name = models.CharField(max_length=255)
    # Пояснение автора к файлу («что тут снято»), решение владельца 05.09:
    # человек собирает партию файлов и отправляет их одним рейсом вместе с
    # описанием. МЕТАДАННЫЕ МОМЕНТА СОЗДАНИЯ: задаётся только в
    # `upload_evidence`, PATCH на доказательство нет и не появится — иначе
    # подпись «вот что на фото» можно было бы переписать задним числом, уже
    # после того как вторая сторона файл увидела. Хранится открытым текстом,
    # как `file_name`: это подпись к юрзначимому артефакту, она обязана
    # читаться в споре и в архивной выгрузке (гео — другое дело, там ПД по
    # ADR-045, поэтому только шифротекстом).
    description = models.CharField(max_length=2000, blank=True, default="")
    mime_type = models.CharField(max_length=100)
    file_size = models.PositiveIntegerField()
    file_hash = models.CharField(max_length=64)
    trusted_timestamp_at = models.DateTimeField()
    trusted_timestamp_source = models.CharField(max_length=32)

    thumbnail = models.BinaryField(null=True, blank=True)
    metadata = models.JSONField(default=dict, blank=True)

    storage_mode = models.CharField(max_length=8, choices=StorageMode.choices)
    transit_payload = models.BinaryField(null=True, blank=True)
    s3_object_key = models.CharField(max_length=255, blank=True, default="")
    # SubjectKey конверта (`common.crypto`, субъект ("evidence", id)) —
    # пусто у объектов до ADR-136 (открытые байты в S3 до backfill).
    encryption_key_ref = models.CharField(max_length=64, blank=True, default="")

    # --- RetentionTimer (ADR-036) — состояние строки; таймер — на договоре ---
    retention_state = models.CharField(
        max_length=16, choices=RetentionState.choices, default=RetentionState.HOT
    )
    archived_at = models.DateTimeField(null=True, blank=True)
    shredded_at = models.DateTimeField(null=True, blank=True)

    uploader_retained_at = models.DateTimeField(auto_now_add=True)
    delivered_to_counterparty_at = models.DateTimeField(null=True, blank=True)
    delivery_status = models.CharField(
        max_length=16, choices=DeliveryStatus.choices, default=DeliveryStatus.IN_TRANSIT
    )

    backup_status = models.CharField(
        max_length=16, choices=BackupStatus.choices, default=BackupStatus.NOT_REQUESTED
    )
    backup_provider = models.CharField(max_length=32, blank=True, default="")
    backup_completed_at = models.DateTimeField(null=True, blank=True)
    backup_failure_reason = models.TextField(blank=True, default="")
    # Заполняются только реальным провайдером (RealGoogleDriveBackupProvider,
    # ADR-084) — фейк их не возвращает содержательно. Нужны для
    # идемпотентности POST /evidence/{id}/backup: повторный запрос при уже
    # COMPLETED статусе возвращает существующий файл, не плодит дубли в
    # Drive пользователя (docs/tasks/Задача_feat_evidence-drive.md §2.3).
    backup_drive_file_id = models.CharField(max_length=255, blank=True, default="")
    backup_drive_web_view_link = models.URLField(blank=True, default="")

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "evidence"
        verbose_name = "доказательство"
        verbose_name_plural = "доказательства"
        ordering = ["-created_at"]
        constraints = [
            # Привязка к этапу ИЛИ спору (etap-4.md/ГВ.3: "привязка к
            # этапу/чек-пункту/спору") — checklist_item уточняет milestone,
            # не заменяет её.
            models.CheckConstraint(
                condition=Q(milestone__isnull=False) | Q(dispute__isnull=False),
                name="evidence_attached_to_milestone_or_dispute",
            ),
            # Значения TextChoices не видны из области Meta (вложенный
            # класс) — литералы дублируют choices намеренно (тот же приём,
            # что domain_deadline_starts_from_valid).
            models.CheckConstraint(
                condition=Q(lateness__in=["unknown", "on_time", "late", "after_acceptance"]),
                name="evidence_lateness_valid",
            ),
            models.CheckConstraint(
                condition=Q(retention_state__in=["hot", "archived", "shredded"]),
                name="evidence_retention_state_valid",
            ),
            # Уничтоженный оригинал: ни ключа объекта, ни транзитной копии —
            # хеш/миниатюра/метаданные остаются (ADR-036 «хеши бессрочно»).
            models.CheckConstraint(
                condition=~Q(retention_state="shredded")
                | Q(s3_object_key="", transit_payload__isnull=True, shredded_at__isnull=False),
                name="evidence_shredded_has_no_original",
            ),
        ]
        indexes = [
            models.Index(fields=["contract", "milestone"]),
            # tech-spec.md §5.2.8 INDEX (original_sha256) — дедуп/анти-фрод:
            # тот же хеш в другом договоре -> событие evidence.duplicate_hash.
            models.Index(fields=["file_hash"], name="evidence_file_hash_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.contract_id}:{self.file_name}"


class RetentionTimer(models.Model):
    """Таймер хранения доказательств ДОГОВОРА (ADR-036/ADR-137, tech-spec.md
    §4 «RetentionTimer»): один на договор, стартует по окончанию сделки
    (`contract.completed` — работы приняты и оплачены; `contract.terminated`;
    `contract.closed` — фолбэк, ADR-137: срок платформы НЕ привязан к
    длительности гарантии сторон; `apps.evidence.handlers`). Три дедлайна —
    строки `DomainDeadline` (`apps.deadlines`, sweep каждую минуту, НЕ
    Celery-задачи), хранятся ПО ЗНАЧЕНИЮ (без FK — тот же приём, что
    `DisputeWindow.deadline_id`): `evidence_hot_retention` (горячее ->
    архив, 3 мес), `evidence_archive_retention` (архив -> уничтожение ключей,
    1 год от окончания) и `evidence_retention_notice` — «скачайте себе» за 10
    дней до уничтожения (ADR-137: уведомление только перед удалением архива,
    перевод в архив ничего не меняет для сторон). Длительности —
    `DeadlineKindConfig` (данные, не константы; deadlines/0009).

    Пауза при открытом споре (`dispute.opened` -> `paused_at`,
    `dispute.resolved` без других открытых споров -> продление дедлайнов на
    длительность паузы): иначе сторону можно было бы дотянуть до уничтожения
    улик (ADR-036). ЖЁСТКИЙ предел ADR-137: продление не дальше 6 месяцев
    (`evidence_dispute_pause_cap`) после завершения спора — проверка в
    `services.resume_retention_timer`, не соглашение.

    `state` дублирует агрегат по строкам Evidence договора (hot/archived/
    shredded) — для `GET /contracts/{id}/retention` спеки (не реализован) и
    идемпотентности свипа: повторная доставка `domain_deadline.fired`
    на уже архивированном таймере — NOOP."""

    class State(models.TextChoices):
        HOT = "hot", "Горячее хранение"
        ARCHIVED = "archived", "Архив"
        SHREDDED = "shredded", "Оригиналы уничтожены (ключи)"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    contract = models.OneToOneField(
        "contracts.Contract", related_name="evidence_retention_timer", on_delete=models.CASCADE
    )
    anchored_at = models.DateTimeField()
    state = models.CharField(max_length=16, choices=State.choices, default=State.HOT)

    hot_deadline_id = models.UUIDField()
    archive_deadline_id = models.UUIDField()
    notice_deadline_id = models.UUIDField()

    paused_at = models.DateTimeField(null=True, blank=True)
    pause_reason = models.CharField(max_length=255, blank=True, default="")
    # Суммарная длительность прошлых пауз — для честного ответа «до какого
    # числа» без пересчёта по дедлайнам.
    paused_total = models.DurationField(default=timedelta(0))

    archived_at = models.DateTimeField(null=True, blank=True)
    shredded_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "evidence_retention_timer"
        verbose_name = "таймер хранения доказательств"
        verbose_name_plural = "таймеры хранения доказательств"
        constraints = [
            models.CheckConstraint(
                condition=Q(state__in=["hot", "archived", "shredded"]),
                name="evidence_retention_timer_state_valid",
            ),
            # Порядок необратим: архив ⇒ дата архива; уничтожение ⇒ обе даты.
            models.CheckConstraint(
                condition=Q(state="hot")
                | Q(state="archived", archived_at__isnull=False)
                | Q(state="shredded", archived_at__isnull=False, shredded_at__isnull=False),
                name="evidence_retention_timer_dates_follow_state",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.contract_id}:{self.state}"
