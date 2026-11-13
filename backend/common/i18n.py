"""Механизм выбора языка запроса (ГВ.5, docs/tasks/global-wave.md, ADR-075;
расширен Л.2, docs/tasks/l10n-wave.md, ADR-077; переработан ADR-095) — общий
для application/problem+json ошибок (common/api/exceptions.py), уведомлений
(apps.notifications.services.place_notification) и других мест, которым нужен
язык текущего запроса/получателя без знания про JWT и аутентификацию.

common/ — не bounded context (вне графа import-linter, root_package="apps") и
по духу CLAUDE.md остаётся ФУНДАМЕНТОМ: apps.* импортируют common, не
наоборот. Единственные исключения здесь — apps.jurisdictions и apps.l10n:
оба спроектированы нижним слоем («ни от кого не зависят», ADR-070/Л.2)
именно чтобы быть безопасной универсальной зависимостью, в том числе для
common/. User здесь НЕ импортируется — читаем поля дак-тайпингом (объект уже
аутентифицирован к моменту вызова, см. resolve_request_locale).

Порядок источников (ADR-095), от сильного к слабому:

  1. `user.locale` — ЯВНЫЙ выбор в переключателе языка. Сильнее страны:
     контур умеет сказать только «ru» или «en» (плагинов всего два, RU и
     GLOBAL), поэтому до ADR-095 немец с country_code=DE получал английские
     письма при немецком интерфейсе, а россиянин, переключившийся на
     English, — русские ошибки. Страна отвечает на вопрос «по какому праву»,
     язык — «на каком языке читать»; это разные факты, и смешивать их было
     ошибкой.
  2. `user.country_code` -> `JurisdictionConfig.primary_locale` — прежнее
     поведение ГВ.5, теперь фолбэк: язык не выбран, но страна известна.
     Исключение — `GLOBAL`: это стартовый маркер Google-входа, не выбор
     страны, источником языка не считается (№5 отсмотра 2026-08-18, см.
     resolve_user_locale).
  3. `Accept-Language` — подсказка браузера (тот же принцип «гео/браузер —
     подсказка, не решение», ADR-070), для анонимных и для тех, кто не
     выбрал ни язык, ни страну.
  4. DEFAULT_LOCALE.

Шаг 1 наполняется НЕ только переключателем языка: с ADR-148 регистрация
(и вход тем, у кого языка ещё нет) фиксирует в `User.locale` язык запроса —
`resolve_signup_locale` ниже. До этого поле оставалось пустым у всех, кто
переключателя не касался (на проде — у 7 из 9 аккаунтов), и язык каждый раз
пересчитывался из заголовка: одинаково для интерфейса, но невидимо для
уведомлений, которые готовятся ВНЕ запроса, и для аналитики языков.
"""

from __future__ import annotations

from typing import Any, Protocol

from apps.jurisdictions.models import GLOBAL_COUNTRY_CODE
from apps.jurisdictions.selectors import resolve_locale
from apps.l10n.selectors import match_enabled_locale

# ru/en — встроенная пара, гарантированная без всякого пакета (RU-контур и
# EN-канон, ГВ.5). Любой другой язык распознаётся, только если для него
# есть включённый apps.l10n.Locale (Л.2) — импортированный пакет.
SUPPORTED_LOCALES = ("ru", "en")
DEFAULT_LOCALE = "ru"


class _HasCountryCode(Protocol):
    country_code: str | None


def match_locale(tag: str | None) -> str | None:
    """Произвольный языковой тег -> код, на котором у нас реально есть тексты.

    Сначала встроенная пара (она существует без всякого пакета), потом
    включённые `Locale` через полноценный BCP-47 lookup
    (`apps.l10n.selectors.match_enabled_locale` — точное совпадение,
    отбрасывание субтегов, единственный региональный вариант). Прежняя
    реализация обрубала тег до первой подгруппы ДО всякого поиска, из-за чего
    `pt-BR` искался как `pt` и не находился никогда."""
    if not tag:
        return None
    normalized = tag.strip()
    if not normalized:
        return None
    if normalized.lower() in SUPPORTED_LOCALES:
        return normalized.lower()
    return match_enabled_locale(normalized)


def _parse_accept_language(header: str | None) -> str | None:
    """RFC 4647 lookup по Accept-Language с учётом q-весов.

    Раньше брался ТОЛЬКО первый тег заголовка. Браузер шлёт список с
    приоритетами (`de-DE,de;q=0.9,en;q=0.8`), и если первый тег нам не
    подходит, правильный ответ — следующий по весу, а не сразу дефолт:
    прежний код на `zh-CN,zh;q=0.9,en;q=0.8` отдавал русский, хотя человек
    прямо сказал, что английский его устроит."""
    if not header:
        return None

    weighted: list[tuple[float, int, str]] = []
    for order, part in enumerate(header.split(",")):
        tag, _, params = part.strip().partition(";")
        tag = tag.strip()
        if not tag or tag == "*":
            continue
        quality = 1.0
        for param in params.split(";"):
            key, _, value = param.partition("=")
            if key.strip().lower() == "q":
                try:
                    quality = float(value.strip())
                except ValueError:
                    quality = 0.0
        if quality <= 0:
            continue
        # order — тай-брейк: при равных весах выигрывает более левый тег,
        # как того требует RFC 4647 (порядок в заголовке значим).
        weighted.append((-quality, order, tag))

    for _, _, tag in sorted(weighted):
        matched = match_locale(tag)
        if matched is not None:
            return matched
    return None


def resolve_user_locale(user: Any) -> str | None:
    """Язык ПОЛЬЗОВАТЕЛЯ (шаги 1–2 порядка из докстринга модуля), без
    участия запроса — то, что нужно уведомлениям: письмо готовится вне
    HTTP-запроса получателя, Accept-Language там взять неоткуда.

    `country_code=GLOBAL` источником языка НЕ считается (отсмотр прода
    2026-08-18 №5): его пишет Google-вход КАЖДОМУ новому пользователю
    («GLOBAL-контур по построению», accounts.services.complete_google_login,
    ГВ.2/ГВ.5) — это стартовый маркер контура, а не явный выбор страны.
    До правки primary_locale контура (en) перебивал Accept-Language: ru, и
    русскоязычный пользователь видел английский каталог при русском
    интерфейсе. Настоящая страна (RU, DE, …) — по-прежнему источник.

    `None` — у пользователя нет ни выбранного языка, ни НАСТОЯЩЕЙ страны;
    вызывающая сторона решает свой фолбэк (уведомления —
    primary_locale контура получателя, то есть для GLOBAL остался en)."""
    if user is None or not getattr(user, "is_authenticated", True):
        return None

    chosen = match_locale(getattr(user, "locale", None))
    if chosen is not None:
        return chosen

    country_code = getattr(user, "country_code", None)
    if country_code and country_code != GLOBAL_COUNTRY_CODE:
        return resolve_locale(country_code)
    return None


def _accept_language_header(request: Any) -> str | None:
    """Accept-Language текущего запроса — из headers или из META (запрос
    может быть и DRF Request, и голым HttpRequest, и тестовым двойником)."""
    headers = getattr(request, "headers", None)
    if headers is not None:
        header = headers.get("Accept-Language")
        if isinstance(header, str):
            return header
    meta = getattr(request, "META", None)
    if meta is not None:
        value = meta.get("HTTP_ACCEPT_LANGUAGE")
        if isinstance(value, str):
            return value
    return None


def resolve_signup_locale(request: Any) -> str | None:
    """Язык, который запрос СКАЗАЛ О СЕБЕ САМ, — шаг 3 порядка выше и НИЧЕГО
    больше: ни страны, ни DEFAULT_LOCALE (ADR-148).

    Нужен ровно одному потребителю — регистрации/входу
    (apps.accounts.services.verify_otp / complete_google_login), который
    ЗАПИСЫВАЕТ полученное в `User.locale`. Поэтому фолбэки здесь вредны:
    resolve_request_locale обязан вернуть язык всегда и в крайнем случае
    отдаёт DEFAULT_LOCALE ("ru") — записать этот дефолт в профиль значило бы
    выдать умолчание за факт и, например, назначить русский язык
    Google-пользователю, чей клиент вообще не прислал Accept-Language.
    `None` — «запрос про язык ничего не сказал», профиль остаётся пустым и
    читается прежней цепочкой фолбэков.

    SPA шлёт Accept-Language на каждом запросе из активного языка интерфейса
    (packages/core/src/api/client.ts, DEV-16b), так что для веб-регистрации
    это язык, на котором человек реально видит приложение в этот момент, а не
    абстрактная настройка браузера."""
    return _parse_accept_language(_accept_language_header(request))


def resolve_request_locale(request: Any) -> str:
    """Язык текущего запроса — порядок источников см. в докстринге модуля."""
    user = getattr(request, "user", None)
    global_marker = False
    if user is not None and getattr(user, "is_authenticated", False):
        from_user = resolve_user_locale(user)
        if from_user is not None:
            return from_user
        # «Нет страны» — тот же маркер, что и GLOBAL: с ADR-148 Google-вход
        # больше не пишет литерал GLOBAL, а оставляет country_code пустым
        # (модель: NULL = «не выбрана», резолвится в контур GLOBAL). Старые
        # строки с GLOBAL живут на проде и после правки — проверяем оба вида.
        country_code = getattr(user, "country_code", None)
        global_marker = not country_code or country_code == GLOBAL_COUNTRY_CODE

    from_header = _parse_accept_language(_accept_language_header(request))
    if from_header is not None:
        return from_header
    # Пользователь без своей страны и без пригодного Accept-Language: язык
    # контура (en), как и до правки, — глобальный DEFAULT_LOCALE ("ru") здесь
    # был бы регрессом ГВ.5 (см. аналогичный фолбэк в
    # notifications.place_notification).
    if global_marker:
        return resolve_locale(GLOBAL_COUNTRY_CODE)
    return DEFAULT_LOCALE
