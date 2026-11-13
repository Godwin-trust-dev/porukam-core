from __future__ import annotations

from typing import Any

from rest_framework import serializers

from ..models import Locale

# Английские названия языков — статический справочник поддерживаемых кодов
# (docs/tasks/Задача_fix_web-locales-switcher.md §4.1: "не БД-волна
# переводов" — внешний конвейер импорта пакетов, apps.l10n.services.
# import_pack, отвечает за КОНТЕНТ перевода, не за этот список отображаемых
# имён). Ключи — ISO 639-1 без региона, тот же набор, что фронтовый мок
# (web/src/mocks/localesDb.ts) заранее зеркалировал как контракт будущего
# эндпоинта (DEV-16a §3) — используем те же значения, чтобы бэк и фронт не
# разошлись по написанию. Родное/само-название (self_name) хранится в
# Locale.name (миграция 0002_seed_locales, apps.l10n.services.import_pack) —
# отдельного справочника для него не нужно.
ENGLISH_NAMES: dict[str, str] = {
    "en": "English",
    "ru": "Russian",
    "es": "Spanish",
    "de": "German",
    "fr": "French",
    "it": "Italian",
    "pl": "Polish",
    "ro": "Romanian",
    "uk": "Ukrainian",
    "tr": "Turkish",
    "az": "Azerbaijani",
    "hy": "Armenian",
    "ka": "Georgian",
    "kk": "Kazakh",
    "uz": "Uzbek",
    "id": "Indonesian",
    "vi": "Vietnamese",
    "th": "Thai",
    "hi": "Hindi",
    "sw": "Swahili",
    "ja": "Japanese",
    "ko": "Korean",
    "bn": "Bengali",
    "ar": "Arabic",
    "fa": "Persian",
    "he": "Hebrew",
    "ur": "Urdu",
    # Регион-тэгированные коды — реальные импортированные пакеты (l10n/packs/)
    # используют их так, не голые "pt"/"zh" (сверено `l10n/packs/*.json`).
    "pt-BR": "Portuguese (Brazil)",
    "zh-Hans": "Chinese (Simplified)",
}


class LocaleSerializer(serializers.ModelSerializer[Locale]):
    """Шейп ровно под фронтовый контракт `LocaleInfo`
    (packages/core/src/api/types.ts) — тот же, что до этой правки описывал
    только мок (web/src/mocks/localesDb.ts, DEV-16a §3): `self_name`/
    `english_name` вместо единственного `name`, `quality` сведено к
    бинарному `human`/`machine` (не 3 модельных значения canonical/
    reviewed/machine — фронту нужен только бейдж beta), `dir` вместо
    булева `rtl`, и `enabled` — раньше вообще не сериализовался, из-за
    чего фронт получал undefined и считал ВСЕ языки выключенными
    (docs/tasks/Задача_fix_web-locales-switcher.md, корень бага "интерфейс
    застрял на английском")."""

    self_name = serializers.CharField(source="name")
    english_name = serializers.SerializerMethodField()
    dir = serializers.SerializerMethodField()
    quality = serializers.SerializerMethodField()

    class Meta:
        model = Locale
        fields = ["code", "self_name", "english_name", "quality", "enabled", "dir"]
        read_only_fields = fields

    def get_english_name(self, obj: Locale) -> str:
        return ENGLISH_NAMES.get(obj.code, obj.name)

    def get_dir(self, obj: Locale) -> str:
        return "rtl" if obj.rtl else "ltr"

    def get_quality(self, obj: Locale) -> str:
        return binary_quality(obj.quality)


def binary_quality(quality: str) -> str:
    """canonical (EN) и reviewed (человеком) — обе "готовые" для фронта,
    бейдж beta нужен только для machine (packages/core/src/api/types.ts::
    LocaleInfo.quality: 'human' | 'machine'). Общая функция, а не метод
    сериализатора: то же сведение нужно и юр-документу
    (LegalDocumentSerializer), пометка «машинный перевод» на нём — та же
    честность о том же факте."""
    return "machine" if quality == Locale.Quality.MACHINE else "human"


class LegalDocumentSerializer(serializers.Serializer[Any]):
    """`GET /v1/legal/<doc>` — юр-документ платформы на языке пользователя
    (docs/tasks/Задача_feat_l10n-launch-surfaces.md §B). Не ModelSerializer:
    источник — `selectors.LegalDocument` (пакет + фолбэк-цепочка), не строка
    таблицы.

    `locale` ≠ `requested_locale` — честный признак сработавшего фолбэка на
    `en`: фронт обязан отличать «документ на вашем языке» от «документа не
    оказалось, вот английский» (§0 постановки — правило «каждое слово на
    языке пользователя», фолбэк остаётся защитой, а не нормой)."""

    doc = serializers.CharField()
    locale = serializers.CharField()
    requested_locale = serializers.CharField()
    authoritative_locale = serializers.CharField()
    quality = serializers.CharField()
    notice = serializers.CharField(allow_null=True)
    body = serializers.CharField()
