"""apps.archive — доказательный пакет сделки и его выдача сторонам (ADR-139;
ADR-036 «экспорт: PDF с оглавлением + ZIP с манифестом хешей, проверяется
без участия платформы»; ADR-137 «выдача архива обеим сторонам при
завершении, пакет — почтой, файлы — ссылкой, ссылка живёт дольше данных»).

Приложение — read-композиция поверх contracts/milestones/payments/disputes/
evidence (только фасады/селекторы, как apps.dashboards, ADR-090) + две
СВОИ таблицы: `ArchiveExport` (одна сборка) и `ArchiveLink` (долгоживущая
ссылка `/a/<token>` конкретной стороны на конкретный артефакт).

Два артефакта у одной сборки (ADR-137 «разделение по размеру»):
- `package.zip` — доказательный пакет (manifest.json, SHA256SUMS, README,
  чекпойнт + .tsr/chain.pem, index.html, verify.py) — килобайты, хранится
  БЕССРОЧНО (ADR-137 треб. 5-6: запись сделки, хеши и метки не удаляются);
- `files.zip` — оригиналы + миниатюры — мегабайты, живёт по сроку хранения
  оригиналов (RetentionTimer, ADR-136): `evidence.shredded` -> ключ конверта
  уничтожен, объект удалён, `files_state=shredded`, ссылка отвечает 410.

Оба объекта в бакете лежат ШИФРОТЕКСТОМ того же конверта `common.crypto`,
что и оригиналы (ADR-136): открытый zip тех же фотографий рядом с
зашифрованными оригиналами обнулил бы и шифрование at rest, и
crypto-shredding. Субъекты РАЗНЫЕ — `("archive_files", export_id)` и
`("archive_package", export_id)` — чтобы уничтожить ключ файлов, не трогая
пакет. Следствие: presigned-ссылок на объект нет, выдача — стримом через
приложение с расшифровкой (`api/views.ArchiveLinkView`)."""

from __future__ import annotations

from django.conf import settings
from django.db import models
from django.db.models import Q

from common.uuid7 import uuid7


class ArchiveExport(models.Model):
    class Trigger(models.TextChoices):
        MANUAL = "manual", "По запросу стороны"
        AUTO = "auto", "Автоматически при завершении сделки"

    class Status(models.TextChoices):
        QUEUED = "queued", "В очереди"
        RUNNING = "running", "Собирается"
        READY = "ready", "Готов"
        FAILED = "failed", "Ошибка сборки"

    class FilesState(models.TextChoices):
        NOT_REQUESTED = "not_requested", "Файлы не запрашивались (manifest_only)"
        PENDING = "pending", "Собираются"
        AVAILABLE = "available", "Доступны"
        SHREDDED = "shredded", "Удалены по сроку хранения"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    contract = models.ForeignKey(
        "contracts.Contract", related_name="archive_exports", on_delete=models.CASCADE
    )
    requested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        related_name="archive_exports",
        null=True,
        blank=True,
        on_delete=models.PROTECT,
    )
    trigger = models.CharField(max_length=16, choices=Trigger.choices)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.QUEUED)
    include_originals = models.BooleanField(default=True)
    manifest_only = models.BooleanField(default=False)
    # Снимок: сделка ещё не окончена на момент сборки (DEV-12 «снимок на
    # {дата}»). `snapshot_at` — граница состава (события/доказательства до
    # неё) и единственный источник времени в пакете: повторная сборка того же
    # экспорта даёт те же байты.
    is_snapshot = models.BooleanField(default=False)
    snapshot_at = models.DateTimeField()

    package_key = models.CharField(max_length=255, blank=True, default="")
    package_size = models.BigIntegerField(null=True, blank=True)
    package_sha256 = models.CharField(max_length=64, blank=True, default="")
    package_key_ref = models.CharField(max_length=64, blank=True, default="")

    files_state = models.CharField(
        max_length=16, choices=FilesState.choices, default=FilesState.PENDING
    )
    files_key = models.CharField(max_length=255, blank=True, default="")
    files_size = models.BigIntegerField(null=True, blank=True)
    files_sha256 = models.CharField(max_length=64, blank=True, default="")
    files_key_ref = models.CharField(max_length=64, blank=True, default="")
    files_shredded_at = models.DateTimeField(null=True, blank=True)
    # Срок жизни файлов = срок хранения оригиналов (archive_until таймера);
    # None — таймер ещё не стартовал (снимок по идущей сделке).
    files_expires_at = models.DateTimeField(null=True, blank=True)

    # Манифест и SHA256SUMS дублируются в БД (килобайты): после удаления
    # файлов ссылка `/a/<token>` обязана по-прежнему отдавать хеши и метку
    # (ADR-137 «ссылка живёт дольше данных»).
    manifest = models.JSONField(default=dict, blank=True)
    sha256sums = models.TextField(blank=True, default="")
    evidence_count = models.PositiveIntegerField(default=0)

    error = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    delivered_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "archive_export"
        verbose_name = "экспорт архива сделки"
        verbose_name_plural = "экспорты архива сделки"
        ordering = ["-created_at"]
        constraints = [
            models.CheckConstraint(
                condition=Q(status__in=["queued", "running", "ready", "failed"]),
                name="archive_export_status_valid",
            ),
            models.CheckConstraint(
                condition=Q(files_state__in=["not_requested", "pending", "available", "shredded"]),
                name="archive_export_files_state_valid",
            ),
            # Готовый экспорт всегда имеет пакет; уничтоженные файлы — дату.
            models.CheckConstraint(
                condition=~Q(status="ready") | ~Q(package_key=""),
                name="archive_export_ready_has_package",
            ),
            models.CheckConstraint(
                condition=~Q(files_state="shredded")
                | Q(files_key="", files_shredded_at__isnull=False),
                name="archive_export_shredded_has_no_files",
            ),
        ]
        indexes = [models.Index(fields=["contract", "status"])]

    def __str__(self) -> str:
        return f"{self.contract_id}:{self.status}"


class ArchiveLink(models.Model):
    """Долгоживущая ссылка `/a/<token>` (ADR-137 «Долгоживущие ссылки»):
    токен ≥ 128 бит (`secrets.token_urlsafe(32)` = 256 бит), в БД — только
    sha256 токена; сторона (`party_role` + получатель) и артефакт (`kind`).
    Доступ без авторизации (через два года пароль не вспомнят), компенсация —
    рейт-лимит, отзыв, лог обращений (`archive.link_accessed` -> Audit Vault)."""

    class Kind(models.TextChoices):
        PACKAGE = "package", "Доказательный пакет"
        FILES = "files", "Файлы (оригиналы, миниатюры)"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    export = models.ForeignKey(ArchiveExport, related_name="links", on_delete=models.CASCADE)
    kind = models.CharField(max_length=16, choices=Kind.choices)
    party_role = models.CharField(max_length=16)
    recipient = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        related_name="archive_links",
        null=True,
        blank=True,
        on_delete=models.PROTECT,
    )
    token_hash = models.CharField(max_length=64, unique=True)
    # Сам токен — шифротекстом (субъект ("archive_link", id)): показать URL
    # его владельцу в API стороны (window.open не несёт Authorization);
    # отзыв = уничтожение ключа, повторно показать нельзя.
    token_encrypted = models.BinaryField(null=True, blank=True)
    token_key_ref = models.CharField(max_length=64, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    last_access_at = models.DateTimeField(null=True, blank=True)
    access_count = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "archive_link"
        verbose_name = "ссылка на архив"
        verbose_name_plural = "ссылки на архив"
        constraints = [
            models.CheckConstraint(
                condition=Q(kind__in=["package", "files"]), name="archive_link_kind_valid"
            ),
            models.CheckConstraint(
                condition=Q(party_role__in=["customer", "contractor"]),
                name="archive_link_party_role_valid",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.export_id}:{self.kind}:{self.party_role}"
