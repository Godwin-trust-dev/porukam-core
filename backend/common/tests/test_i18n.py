"""common/i18n.py — механизм выбора языка по контуру/Accept-Language (ГВ.5,
docs/tasks/global-wave.md, ADR-075)."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from common.i18n import (
    DEFAULT_LOCALE,
    _parse_accept_language,
    resolve_request_locale,
    resolve_signup_locale,
)

pytestmark = pytest.mark.django_db


class _FakeUser:
    def __init__(self, *, is_authenticated: bool, country_code: str | None = None) -> None:
        self.is_authenticated = is_authenticated
        self.country_code = country_code


def _request(*, user=None, accept_language: str | None = None):
    headers = {"Accept-Language": accept_language} if accept_language else {}
    return SimpleNamespace(user=user, headers=headers, META={})


# --- _parse_accept_language --------------------------------------------


@pytest.mark.parametrize(
    "header,expected",
    [
        (None, None),
        ("", None),
        ("en", "en"),
        ("en-US,en;q=0.9,ru;q=0.8", "en"),
        ("ru-RU,ru;q=0.9", "ru"),
        ("fr-FR,fr;q=0.9", None),  # неподдерживаемая локаль
    ],
)
def test_parse_accept_language(header, expected):
    assert _parse_accept_language(header) == expected


# --- resolve_request_locale ---------------------------------------------


def test_authenticated_ru_user_resolves_to_ru():
    request = _request(user=_FakeUser(is_authenticated=True, country_code="RU"))
    assert resolve_request_locale(request) == "ru"


def test_global_marker_does_not_override_accept_language():
    """✅ №5 отсмотра 2026-08-18: `country_code=GLOBAL` пишет Google-вход
    КАЖДОМУ новому пользователю — это стартовый маркер контура, не выбор
    страны. Раньше primary_locale контура (en) перебивал Accept-Language: ru,
    и русскоязычный пользователь видел английский каталог при русском
    интерфейсе."""
    request = _request(
        user=_FakeUser(is_authenticated=True, country_code="GLOBAL"),
        accept_language="ru-RU",
    )
    assert resolve_request_locale(request) == "ru"


def test_global_marker_without_accept_language_falls_back_to_contour_en():
    """GLOBAL без пригодного Accept-Language — язык контура (en), как и до
    правки: глобальный DEFAULT_LOCALE ("ru") был бы регрессом ГВ.5."""
    request = _request(user=_FakeUser(is_authenticated=True, country_code="GLOBAL"))
    assert resolve_request_locale(request) == "en"


def test_global_marker_with_unsupported_accept_language_falls_back_to_contour_en():
    request = _request(
        user=_FakeUser(is_authenticated=True, country_code="GLOBAL"),
        accept_language="fr-FR,fr;q=0.9",
    )
    assert resolve_request_locale(request) == "en"


def test_authenticated_user_without_country_falls_back_to_accept_language():
    request = _request(
        user=_FakeUser(is_authenticated=True, country_code=None), accept_language="en"
    )
    assert resolve_request_locale(request) == "en"


def test_authenticated_user_without_country_and_header_gets_contour_en():
    """ADR-148: Google-вход больше не пишет литерал GLOBAL, поэтому «страна
    не выбрана» — тот же маркер контура, что раньше был GLOBAL. Без него
    такой пользователь получал бы DEFAULT_LOCALE ("ru") — ровно тот регресс
    ГВ.5, от которого защищает тест выше про GLOBAL."""
    request = _request(user=_FakeUser(is_authenticated=True, country_code=None))
    assert resolve_request_locale(request) == "en"


def test_anonymous_request_uses_accept_language():
    request = _request(user=None, accept_language="en-US,en;q=0.9")
    assert resolve_request_locale(request) == "en"


def test_anonymous_request_without_accept_language_defaults_to_ru():
    request = _request(user=None)
    assert resolve_request_locale(request) == DEFAULT_LOCALE == "ru"


def test_unauthenticated_user_object_treated_as_anonymous():
    """DRF AnonymousUser: is_authenticated=False — контур не читается,
    даже если бы у объекта случайно было поле country_code."""
    request = _request(
        user=_FakeUser(is_authenticated=False, country_code="RU"), accept_language="en"
    )
    assert resolve_request_locale(request) == "en"


# --- ADR-095: выбранный язык интерфейса сильнее контура ------------------


class _FakeUserWithLocale(_FakeUser):
    def __init__(self, *, locale: str | None = None, **kwargs) -> None:
        super().__init__(**kwargs)
        self.locale = locale


@pytest.fixture
def _de_pack():
    from apps.l10n import services as l10n_services

    l10n_services.import_pack(
        {
            "locale": "de",
            "name": "Deutsch",
            "rtl": False,
            "quality": "machine",
            "pack_version": 1,
            "errors": {},
            "notifications": {},
            "catalog": {},
            "clauses": {},
            "legal": {},
        }
    )


def test_chosen_locale_beats_country(_de_pack):
    """✅ ADR-095, главный случай: немец с country_code=DE попадает в контур
    GLOBAL (en). До ADR-095 он и получал английский, хотя интерфейс выбрал
    немецкий, — контур физически не умел сказать "de"."""
    request = _request(
        user=_FakeUserWithLocale(is_authenticated=True, country_code="DE", locale="de")
    )
    assert resolve_request_locale(request) == "de"


def test_chosen_locale_beats_ru_country():
    """Обратное направление того же: россиянин, переключившийся на English,
    больше не получает русские заголовки ошибок."""
    request = _request(
        user=_FakeUserWithLocale(is_authenticated=True, country_code="RU", locale="en")
    )
    assert resolve_request_locale(request) == "en"


def test_locale_of_disabled_language_falls_back_to_country():
    """Язык выключен рубильником ops -> сохранённый выбор перестаёт
    применяться, но профиль не ломается (см. докстринг User.locale)."""
    request = _request(
        user=_FakeUserWithLocale(is_authenticated=True, country_code="RU", locale="de"),
    )
    assert resolve_request_locale(request) == "ru"


def test_locale_without_country_is_still_used(_de_pack):
    request = _request(
        user=_FakeUserWithLocale(is_authenticated=True, country_code=None, locale="de")
    )
    assert resolve_request_locale(request) == "de"


def test_anonymous_ignores_locale_attribute(_de_pack):
    request = _request(
        user=_FakeUserWithLocale(is_authenticated=False, country_code="RU", locale="de"),
        accept_language="en",
    )
    assert resolve_request_locale(request) == "en"


# --- ADR-095: BCP-47 lookup вместо огрубления до подгруппы ---------------


@pytest.fixture
def _pt_br_pack():
    from apps.l10n import services as l10n_services

    l10n_services.import_pack(
        {
            "locale": "pt-BR",
            "name": "Português (Brasil)",
            "rtl": False,
            "quality": "machine",
            "pack_version": 1,
            "errors": {},
            "notifications": {},
            "catalog": {},
            "clauses": {},
            "legal": {},
        }
    )


def test_region_tagged_accept_language_no_longer_falls_to_ru(_pt_br_pack):
    """✅ Регресс, ради которого переписан разбор: `pt-BR` обрубался до `pt`,
    среди Locale.code такого не было, и гость-бразилец получал русский."""
    request = _request(user=None, accept_language="pt-BR,pt;q=0.9,en;q=0.8")
    assert resolve_request_locale(request) == "pt-BR"


def test_accept_language_second_tag_wins_when_first_unsupported():
    """Прежний код смотрел ТОЛЬКО первый тег: человек прямо написал, что
    английский его устроит, а получал русский дефолт."""
    request = _request(user=None, accept_language="sv-SE,sv;q=0.9,en;q=0.8")
    assert resolve_request_locale(request) == "en"


def test_accept_language_respects_q_weights():
    """Порядок в заголовке не равен приоритету — решает q."""
    request = _request(user=None, accept_language="ru;q=0.2,en;q=0.9")
    assert resolve_request_locale(request) == "en"


def test_accept_language_zero_weight_is_rejection():
    """`en;q=0` — явный отказ от языка, не «слабое предпочтение»."""
    request = _request(user=None, accept_language="en;q=0")
    assert resolve_request_locale(request) == DEFAULT_LOCALE


def test_accept_language_wildcard_is_not_a_language():
    request = _request(user=None, accept_language="*")
    assert resolve_request_locale(request) == DEFAULT_LOCALE


# --- ADR-148: resolve_signup_locale — только заявленный язык, без фолбэков -


def test_signup_locale_reads_accept_language():
    assert resolve_signup_locale(_request(accept_language="en-US,en;q=0.9")) == "en"


def test_signup_locale_without_header_is_none_not_default():
    """Ключевое отличие от resolve_request_locale: пустой ответ вместо
    DEFAULT_LOCALE. Записать "ru" в профиль тому, кто про язык ничего не
    сказал, — выдать умолчание за факт (см. докстринг функции)."""
    assert resolve_signup_locale(_request()) is None
    assert DEFAULT_LOCALE == "ru"


def test_signup_locale_of_unsupported_language_is_none():
    assert resolve_signup_locale(_request(accept_language="fr-FR,fr;q=0.9")) is None


def test_signup_locale_ignores_user_country():
    """Это язык ЗАПРОСА, не профиля: страна сюда не заглядывает — иначе
    в профиль поехал бы язык контура, а не тот, на котором человек
    регистрируется."""
    request = _request(user=_FakeUser(is_authenticated=True, country_code="RU"))
    assert resolve_signup_locale(request) is None


def test_signup_locale_reads_meta_when_headers_absent():
    """Голый HttpRequest/тестовый двойник без .headers — берём из META."""
    request = SimpleNamespace(user=None, META={"HTTP_ACCEPT_LANGUAGE": "en"})
    assert resolve_signup_locale(request) == "en"
