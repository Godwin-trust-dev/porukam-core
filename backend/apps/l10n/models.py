"""Л.2 (docs/tasks/l10n-wave.md) — инфраструктура языковых пакетов, поверх
фолбэк-механизма ГВ.5 (ADR-075, common/i18n.py) и по решению доку 32
(EN-канон + два рендера в снепшоте — Л.1, отдельная ветка).

Ни от кого не зависит (import-linter, тот же нижний слой, что apps.catalog/
apps.jurisdictions): справочник locale + generic-хранилище текстов пакета,
который читают common/i18n.py и, по мере подключения, другие приложения —
через `apps.l10n.selectors`, не прямым импортом моделей.
"""

from __future__ import annotations

from django.db import models


class Locale(models.Model):
    """Справочник языков (Л.2 п.1) — code (BCP-47), само-название,
    rtl/enabled/quality. `en`/`ru` — сид миграции 0002 (canonical/reviewed);
    остальные языки создаются/обновляются автоматически при импорте пакета
    (`services.import_pack`, из шапки файла), `enabled=True` только на
    создании — дальше это ручной рубильник (например, RTL-волна B3
    docs/tasks/l10n-wave.md держится impортированной, но выключенной, пока
    фронт не готов к `dir="rtl"`), импорт пакета его не трогает."""

    class Quality(models.TextChoices):
        CANONICAL = "canonical", "Канон (EN)"
        REVIEWED = "reviewed", "Проверен носителем"
        MACHINE = "machine", "Машинный перевод (beta)"

    code = models.CharField(max_length=16, primary_key=True)
    name = models.CharField(max_length=64)
    rtl = models.BooleanField(default=False)
    enabled = models.BooleanField(default=True)
    quality = models.CharField(max_length=16, choices=Quality.choices)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "locale"
        verbose_name = "язык"
        verbose_name_plural = "языки"
        ordering = ["code"]

    def __str__(self) -> str:
        return self.code


class LocalePack(models.Model):
    """Последний импортированный языковой пакет (Л.2 п.2-3) — одна строка
    на `Locale` (перезаписывается версионированным импортом, история
    версий не хранится — версионирование живёт в `pack_version` самого
    файла, не в БД). `content` — валидированное, но НЕ перепакованное
    содержимое JSON-файла целиком (namespaces `errors`/`notifications`/
    `catalog`/`clauses`/`legal`/… — см. l10n/README.md); хранение сырым
    деревом, а не разложенным по строкам, — намеренно: пакет читается
    целиком по locale (`selectors.get_pack_text`), не по отдельному ключу,
    а частичность/фолбэк на EN — забота селектора, не схемы таблицы.

    `checksum` — sha256 нормализованного `content`, вместе с `pack_version`
    даёт идемпотентность `import_l10n_pack`: тот же pack_version + тот же
    checksum → no-op; тот же pack_version, но другой checksum → конфликт
    версии (см. services.PackVersionConflictError); pack_version меньше
    текущего → устаревший пакет (services.StalePackError)."""

    locale = models.OneToOneField(
        Locale, primary_key=True, related_name="pack", on_delete=models.CASCADE
    )
    pack_version = models.PositiveIntegerField()
    checksum = models.CharField(max_length=64)
    content = models.JSONField()
    imported_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "locale_pack"
        verbose_name = "языковой пакет"
        verbose_name_plural = "языковые пакеты"

    def __str__(self) -> str:
        return f"{self.locale_id}@{self.pack_version}"
