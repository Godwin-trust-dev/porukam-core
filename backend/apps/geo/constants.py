"""Стартовый список стран для импорта по умолчанию.

Совпадает с `COUNTRY_CODES` из `web/src/features/groups/groupLabels.ts`
(фронт — единственное место, где эти 68 кодов раньше жили; там ими
ограничен выбор страны у витрины-группы). Список продублирован здесь, а не
импортирован из фронта (backend Python не может импортировать TS-модуль) —
при изменении фронтового списка ПРАВИТЬ ОБА МЕСТА руками.

Это только ЗНАЧЕНИЕ ПО УМОЛЧАНИЮ команды `import_geo`: справочник обязан
расширяться без правки кода — `import_geo --countries=all` или явный список
кодов через запятую тянут любые страны источника, не только эти 68
(план 11.09 §3, ADR-179)."""

from __future__ import annotations

import re

DEFAULT_COUNTRY_CODES: frozenset[str] = frozenset(
    {
        # СНГ и соседи
        "RU",
        "KZ",
        "BY",
        "UA",
        "UZ",
        "KG",
        "TJ",
        "TM",
        "AM",
        "AZ",
        "GE",
        "MD",
        # Ближний Восток
        "TR",
        "AE",
        "IL",
        "IR",
        "SA",
        "EG",
        # Европа
        "DE",
        "FR",
        "IT",
        "ES",
        "PT",
        "PL",
        "RO",
        "CZ",
        "NL",
        "BE",
        "AT",
        "CH",
        "GB",
        "IE",
        "SE",
        "NO",
        "FI",
        "DK",
        "GR",
        "RS",
        "BG",
        "HU",
        "LT",
        "LV",
        "EE",
        # Америка
        "US",
        "CA",
        "MX",
        "BR",
        "AR",
        "CL",
        "CO",
        # Азия и АТР
        "IN",
        "PK",
        "BD",
        "ID",
        "VN",
        "TH",
        "MY",
        "SG",
        "PH",
        "JP",
        "KR",
        "CN",
        "AU",
        "NZ",
        # Африка
        "KE",
        "TZ",
        "NG",
        "ZA",
    }
)


# Сопоставление НАШЕЙ локали (BCP-47: код `apps.l10n.Locale`/встроенная пара
# `common.i18n.SUPPORTED_LOCALES`) → код(ы) языка GeoNames в подушевых
# файлах alternatenames (колонка `isolanguage`, обычно ISO 639-1, план 11.09
# §2b, ADR-181). Список локалей — 29 кодов `l10n/packs/*.json`, тот же набор,
# что `apps.l10n.api.serializers.ENGLISH_NAMES` (geo — нижний слой и НЕ
# импортирует apps.l10n даже как соседа по слою, см. models.py докстринг —
# поэтому список продублирован здесь явно, тем же приёмом, что
# DEFAULT_COUNTRY_CODES выше дублирует фронтовый список; при появлении
# нового языкового пакета поправить и то, и другое).
#
# Не всегда 1:1: GeoNames не различает региональные варианты, которые
# различает наш каталог локалей —
# - `pt-BR` (Portuguese, Brazil): GeoNames почти всегда даёт голый `pt` без
#   региона (проверено на реальном дампе `KZ.txt` — код `pt-BR` встретился
#   там ровно один раз на 167 тысяч строк, `pt` — 54 раза), поэтому берём
#   ОБА кода — `pt-BR`, если он всё же есть в конкретной стране, и `pt` как
#   основной источник;
# - `zh-Hans` (упрощённое письмо): GeoNames в массе даёт голый `zh` (Ханьцы
#   не разделены на Hans/Hant в основном потоке правок), `zh-Hant`
#   (традиционное письмо, встретилось как `zh-TW` в том же дампе) сюда
#   осознанно НЕ включён — у нас нет локали для традиционного письма, и
#   подмешивать её тексты под `zh-Hans` значило бы показывать не тот алфавит;
# - `he` (иврит) и `id` (индонезийский) — в исторических дампах встречаются
#   под старыми кодами ISO 639-1 (`iw`, `in` — коды до пересмотра стандарта
#   в 1989/1998), которые GeoNames местами унаследовал; принимаем оба.
#
# Коллизий (один код GeoNames → две наши локали) быть не должно —
# проверяется на импорте модуля (_build_reverse_map ниже, тест
# test_geonames_lang_reverse_map_has_no_collisions).
LOCALE_TO_GEONAMES_LANGS: dict[str, tuple[str, ...]] = {
    "ar": ("ar",),
    "az": ("az",),
    "bn": ("bn",),
    "de": ("de",),
    "en": ("en",),
    "es": ("es",),
    "fa": ("fa",),
    "fr": ("fr",),
    "he": ("he", "iw"),
    "hi": ("hi",),
    "hy": ("hy",),
    "id": ("id", "in"),
    "it": ("it",),
    "ja": ("ja",),
    "ka": ("ka",),
    "kk": ("kk",),
    "ko": ("ko",),
    "pl": ("pl",),
    "pt-BR": ("pt-BR", "pt"),
    "ro": ("ro",),
    "ru": ("ru",),
    "sw": ("sw",),
    "th": ("th",),
    "tr": ("tr",),
    "uk": ("uk",),
    "ur": ("ur",),
    "uz": ("uz",),
    "vi": ("vi",),
    "zh-Hans": ("zh", "zh-Hans"),
}


def _build_reverse_map(mapping: dict[str, tuple[str, ...]]) -> dict[str, str]:
    """Код GeoNames → наша локаль. Падает при загрузке модуля, если один код
    источника случайно сопоставлен двум нашим локалям (правило `import_geo`
    писать локаль ОДНОЗНАЧНО, без выбора между локалями во время импорта)."""
    reverse: dict[str, str] = {}
    for locale, codes in mapping.items():
        for code in codes:
            if code in reverse:
                raise ValueError(
                    f"GeoNames-код {code!r} уже сопоставлен локали {reverse[code]!r} — "
                    f"конфликт с {locale!r} (apps.geo.constants.LOCALE_TO_GEONAMES_LANGS)"
                )
            reverse[code] = locale
    return reverse


#: Код языка GeoNames → наша локаль (обратная сторона LOCALE_TO_GEONAMES_LANGS).
GEONAMES_LANG_TO_LOCALE: dict[str, str] = _build_reverse_map(LOCALE_TO_GEONAMES_LANGS)


# Диапазоны Unicode родной письменности — используются ТОЛЬКО как вторичный
# тай-брейк в `services._select_best_names` (ADR-183, найдено при разборе
# дефекта «Ставрополь показывается как Stavropol’»): если для локали у
# объекта несколько кандидатов с ОДИНАКОВЫМ `is_preferred` (после исключения
# `is_historic`/`is_colloquial`/`is_short`), предпочитается тот, что содержит
# хотя бы один символ РОДНОЙ письменности локали.
#
# ПЕРВАЯ версия правила («предпочесть любой НЕ-ASCII символ») была
# НЕДОСТАТОЧНОЙ — проверено на факте: geonameid 487846 «Ставрополь»,
# alternateNameId 3738190, `ru` = «Stavropol’» — GeoNames тут ЛАТИНСКАЯ
# транслитерация (BGN/PCGN, апостроф U+2019 передаёт мягкий знак), но САМ
# апостроф U+2019 — уже НЕ ASCII, поэтому проверка «есть непустой не-ASCII
# символ» не отличала эту строку от настоящей кириллической «Ставрополь»
# (alternateNameId 5961934) — обе проходили. Нужна проверка именно по
# ДИАПАЗОНУ СКРИПТА локали, не по «ASCII или нет».
#
# Ни `isPreferred`, ни другой флаг источника не отличает эти два варианта —
# подтверждено фактами на живом RU-дампе: 2 из 1108 городов (≈0,2%) —
# единичная особенность источника (не системная дыра импорта), см. ADR-183
# §«Дефект 2».
#
# Локали, для которых родной скрипт — латиница (az, de, en, es, fr, id, it,
# pl, pt-BR, ro, sw, tr, uz, vi), в этом словаре сознательно ОТСУТСТВУЮТ —
# для них тай-брейк не применяется (их подлинные имена и так на латинице,
# добавлять диапазон было бы бессмысленно и рискованно — легитимное имя с
# диакритикой могло бы неожиданно проиграть).
_CYRILLIC = "Ѐ-ӿԀ-ԯ"  # + Cyrillic Supplement (доп. буквы kk/uk)
_ARABIC = "؀-ۿ"
_HEBREW = "֐-׿"
_ARMENIAN = "԰-֏"
_GEORGIAN = "Ⴀ-ჿ"
_DEVANAGARI = "ऀ-ॿ"
_BENGALI = "ঀ-৿"
_THAI = "฀-๿"
_CJK_HAN_KANA = "一-鿿぀-ヿ"  # иероглифы (ja/zh-Hans) + кана (ja)
_HANGUL = "가-힯"

LOCALE_SCRIPT_RANGES: dict[str, str] = {
    "ru": _CYRILLIC,
    "kk": _CYRILLIC,
    "uk": _CYRILLIC,
    "ar": _ARABIC,
    "fa": _ARABIC,
    "ur": _ARABIC,
    "he": _HEBREW,
    "hy": _ARMENIAN,
    "ka": _GEORGIAN,
    "hi": _DEVANAGARI,
    "bn": _BENGALI,
    "th": _THAI,
    "ja": _CJK_HAN_KANA,
    "zh-Hans": _CJK_HAN_KANA,
    "ko": _HANGUL,
}

if not LOCALE_SCRIPT_RANGES.keys() <= LOCALE_TO_GEONAMES_LANGS.keys():
    raise ValueError(
        "LOCALE_SCRIPT_RANGES должно быть подмножеством локалей LOCALE_TO_GEONAMES_LANGS"
    )


# Регистр родовых слов в названиях регионов — ADR-183 (доп. 12.09): GeoNames
# отдаёт русские альтернативные имена регионов В TITLE CASE («Ставропольский
# Край», «Амурская Область», «Чукотский Автономный Округ») — 72 из 83
# субъектов РФ. Официальная (и требуемая владельцем) орфография — родовое
# слово со строчной буквы, ЕСЛИ оно не первое слово названия («Ставропольский
# край», «Амурская область»); если оно первое — с заглавной, как и положено
# первому слову («Край» в начале имени в нашем RU-датасете не встретился, но
# правило должно быть общим, не завязанным на конкретные значения).
#
# «Республика» СОЗНАТЕЛЬНО НЕ входит в список: официальная орфография для
# республик РФ капитализирует это слово в ЛЮБОЙ позиции — и «Республика
# Адыгея» (первое слово), и «Чеченская Республика» (второе слово) пишутся
# с заглавной (проверено: ни то, ни другое не Title Case отдельных СЛОВ —
# «Республика» тут не родовое-в-нижнем-регистре слово вроде «край», а часть
# официального наименования формы правления).
#
# Другие наши локали с нелатинским письмом (`kk`, `uk` — единственные из
# предложенных владельцем {uk, kk, be, bg, sr, mk}, что реально есть в
# LOCALE_TO_GEONAMES_LANGS: be/bg/sr/mk в проекте нет вовсе) ПРОВЕРЕНЫ на
# живом RU-дампе (все 83 региона) — та же болезнь у них НЕ обнаружена:
# `uk` отдаёт родовые слова уже строчными («Ставропольський край»,
# «Амурська область»), `kk` вообще не использует отдельное родовое слово —
# берёт постпозитивный суффикс, слитный с топонимом («Ставрополь өлкесі»,
# «Ярославль облысы») — механически лишнее для этой схемы правило. Если в
# будущем в LOCALE_TO_GEONAMES_LANGS добавится locale с ДЕЙСТВИТЕЛЬНО той же
# болезнью (Title Case родовых слов) — держащая её выдумывать заранее без
# проверки на реальных данных этой локали НЕЛЬЗЯ (см. ADR-183 «Пределы»).
GENERIC_TERM_LOWERCASE: dict[str, frozenset[str]] = {
    "ru": frozenset({"край", "область", "округ", "автономный", "автономная", "автономное"}),
}


def _build_generic_term_pattern(terms: frozenset[str]) -> re.Pattern[str]:
    alternation = "|".join(re.escape(term) for term in sorted(terms))
    return re.compile(rf"\b(?:{alternation})\b", re.IGNORECASE | re.UNICODE)


_GENERIC_TERM_PATTERNS: dict[str, re.Pattern[str]] = {
    locale: _build_generic_term_pattern(terms) for locale, terms in GENERIC_TERM_LOWERCASE.items()
}


def normalize_generic_terms(name: str, locale: str) -> str:
    """Строчит родовые слова локали (`GENERIC_TERM_LOWERCASE`) в `name`,
    КРОМЕ случая, когда слово — самое первое в строке (тогда оно остаётся
    как дал источник — заглавная буква первого слова названия корректна).
    Локаль без записи в `GENERIC_TERM_LOWERCASE` — `name` не трогается.

    ТОЛЬКО для ОТОБРАЖЕНИЯ (`services._select_best_names` — единственный
    вызывающий, встроено в отбор `name_i18n`/`display_name`, ADR-183) — НЕ
    применяется к `CityName.name`/`RegionName.name` (сырые значения
    источника, участвуют в ПОИСКЕ, `apps.geo.selectors`, который обязан
    находить и по написанию источника — Title Case в том числе)."""
    pattern = _GENERIC_TERM_PATTERNS.get(locale)
    if pattern is None or not name:
        return name

    def _lower_unless_first_word(match: re.Match[str]) -> str:
        return match.group(0) if match.start() == 0 else match.group(0).lower()

    return pattern.sub(_lower_unless_first_word, name)
