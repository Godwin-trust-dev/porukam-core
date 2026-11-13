"""Email через Resend (ADR-111): выбор провайдера и ResendEmailProvider.

Юрканал остаётся ЛК (ADR-057) — здесь только дублирующий канал: отправка
локализованного текста шаблона без подстановок, деградация без падения
place_notification. `httpx.post` мокается — наружу тесты не ходят.
"""

from __future__ import annotations

from unittest import mock

import httpx
import pytest

from apps.accounts.models import User
from apps.notifications import email_texts
from apps.notifications import services as notifications_services
from apps.notifications.providers import (
    FakeEmailProvider,
    ResendEmailProvider,
    get_email_provider,
)

pytestmark = pytest.mark.django_db

MESSAGE = {
    "subject": "Этап «{milestone_title}» сдан на приёмку",
    "body": "По договору «{contract_title}» этап сдан. Откройте сделку, чтобы принять работу.",
    "template": "milestone.submitted",
    "locale": "ru",
    "payload": {
        "amount": "100.00",
        "currency": "RUB",
        "contract_title": "Ремонт кухни",
        "contract_number": "A1B2C3",
        "counterparty_name": "Иван Петров",
        "milestone_title": "Плитка",
    },
    "contract_id": "01a02359-6ef5-7466-8712-ef63299b169a",
}


def _user(suffix: str, email: str = "") -> User:
    return User.objects.create(
        trust_id=f"trust-mail-{suffix}", phone=f"+7999092{suffix}", email=email
    )


def test_provider_defaults_to_fake(settings):
    settings.NOTIFICATIONS_EMAIL_PROVIDER = "fake"
    assert isinstance(get_email_provider(), FakeEmailProvider)


def test_provider_resend_by_env(settings):
    settings.NOTIFICATIONS_EMAIL_PROVIDER = "resend"
    assert isinstance(get_email_provider(), ResendEmailProvider)


def test_resend_no_email_address():
    result = ResendEmailProvider().send(_user("001"), MESSAGE)
    assert result.delivered is False
    assert result.status == "no_email"


def test_resend_letter_is_informative_like_cabinet_card(settings):
    """ADR-141 (решение владельца 27.08): подстановки в теме/тексте, мета
    сделки (сделка · контрагент · сумма · этап), кнопка ведёт в сделку."""
    settings.RESEND_API_KEY = "re_key"
    settings.NOTIFICATIONS_EMAIL_FROM = "Porukam <noreply@porukam.app>"
    settings.PUBLIC_WEB_BASE_URL = "https://porukam.app"
    user = _user("002", email="user@example.com")
    response = mock.Mock(status_code=200, json=lambda: {"id": "msg-1"})
    with mock.patch("httpx.post", return_value=response) as post:
        result = ResendEmailProvider().send(user, MESSAGE)
    assert result.delivered is True
    assert result.provider_message_id == "msg-1"
    kwargs = post.call_args.kwargs
    assert kwargs["json"]["to"] == ["user@example.com"]
    assert kwargs["json"]["subject"] == "Этап «Плитка» сдан на приёмку"
    text, html = kwargs["json"]["text"], kwargs["json"]["html"]
    assert "По договору «Ремонт кухни» этап сдан." in text
    assert "{contract_title}" not in text and "{contract_title}" not in html
    assert "Сделка: Ремонт кухни · № A1B2C3" in text
    assert "Контрагент: Иван Петров" in text
    assert "Сумма: 100.00 RUB" in text
    assert "Этап: Плитка" in text
    # ADR-170: кнопка письма ведёт в тот же раздел, что и пункт ленты
    # (шаблон семейства `milestone.` без `milestone_id` — вкладка «Этапы»).
    assert "https://porukam.app/contracts/01a02359-6ef5-7466-8712-ef63299b169a#stages" in text
    assert (
        'href="https://porukam.app/contracts/01a02359-6ef5-7466-8712-ef63299b169a#stages"' in html
    )
    assert "Открыть сделку" in html
    assert "Иван Петров" in html and "100.00 RUB" in html
    assert kwargs["headers"]["Authorization"] == "Bearer re_key"


def test_resend_letter_without_context_falls_back_to_cabinet(settings):
    """Событие без договора (нет contract_id/меты): плейсхолдеры не утекают
    буквально, меты нет, кнопка — в кабинет."""
    settings.RESEND_API_KEY = "re_key"
    settings.PUBLIC_WEB_BASE_URL = "https://porukam.app"
    user = _user("003", email="user3@example.com")
    message = {
        "subject": "Договор «{contract_title}» подписан",
        "body": "Проверьте «{contract_title}».",
        "template": "contract.signed",
        "locale": "ru",
        "payload": {},
    }
    response = mock.Mock(status_code=200, json=lambda: {"id": "msg-2"})
    with mock.patch("httpx.post", return_value=response) as post:
        ResendEmailProvider().send(user, message)
    kwargs = post.call_args.kwargs
    assert kwargs["json"]["subject"] == "Договор «…» подписан"
    assert "{" not in kwargs["json"]["text"]
    assert "Сделка:" not in kwargs["json"]["text"]
    assert "https://porukam.app/notifications" in kwargs["json"]["text"]
    assert "Открыть личный кабинет" in kwargs["json"]["html"]


def test_resend_amount_only_with_currency(settings):
    settings.RESEND_API_KEY = "re_key"
    user = _user("004", email="user4@example.com")
    message = {**MESSAGE, "payload": {**MESSAGE["payload"]}}
    del message["payload"]["currency"]
    response = mock.Mock(status_code=200, json=lambda: {"id": "msg-3"})
    with mock.patch("httpx.post", return_value=response) as post:
        ResendEmailProvider().send(user, message)
    assert "Сумма:" not in post.call_args.kwargs["json"]["text"]


def test_meta_labels_localized_with_en_fallback():
    from apps.notifications.providers import email_meta_rows

    rows_en = email_meta_rows(MESSAGE, locale="en")
    assert rows_en[0][0] == "Deal" and rows_en[2] == ("Amount", "100.00 RUB")
    rows_unknown = email_meta_rows(MESSAGE, locale="xx")
    assert rows_unknown[1][0] == "Counterparty"


def test_resend_letter_carries_unsubscribe_hint_and_cabinet_link(settings):
    """Просьба пользователя 2026-08-23: в тексте писем — что уведомления можно
    отключить в кабинете. Язык приписки — язык уведомления (locale в message)."""
    settings.PUBLIC_WEB_BASE_URL = "https://porukam.app"
    user = _user("005", email="user5@example.com")
    response = mock.Mock(status_code=200, json=lambda: {"id": "msg-2"})
    with mock.patch("httpx.post", return_value=response) as post:
        ResendEmailProvider().send(user, {**MESSAGE, "locale": "ru"})
    payload = post.call_args.kwargs["json"]
    assert "Уведомления можно отключить в настройках личного кабинета." in payload["text"]
    assert "Уведомления можно отключить в настройках личного кабинета." in payload["html"]
    assert "https://porukam.app/me/settings/notifications" in payload["text"]
    assert "https://porukam.app/me/settings/notifications" in payload["html"]
    # ADR-141: у события с договором кнопка ведёт в сделку, не на общую ленту.
    assert "https://porukam.app/contracts/01a02359-6ef5-7466-8712-ef63299b169a" in payload["html"]
    assert "Открыть сделку" in payload["html"]


def test_resend_http_error_degrades():
    user = _user("003", email="user3@example.com")
    response = mock.Mock(status_code=422, json=lambda: {"message": "domain not verified"})
    with mock.patch("httpx.post", return_value=response):
        result = ResendEmailProvider().send(user, MESSAGE)
    assert result.delivered is False
    assert result.status == "http_422"


def test_resend_network_error_degrades():
    user = _user("004", email="user4@example.com")
    with mock.patch("httpx.post", side_effect=httpx.ConnectError("boom")):
        result = ResendEmailProvider().send(user, MESSAGE)
    assert result.delivered is False
    assert result.status == "network_error"


# --- письмо с кодом входа (ADR-168) ----------------------------------------
# Не уведомление: ни Notification, ни DeliveryAttempt, ни настроек каналов —
# это транспорт одноразового кода до того, как пользователь существует.


def test_login_code_letter_carries_code_and_no_notification_footer(settings):
    settings.RESEND_API_KEY = "re_key"
    settings.NOTIFICATIONS_EMAIL_FROM = "Porukam <noreply@porukam.app>"
    settings.PUBLIC_WEB_BASE_URL = "https://porukam.app"
    response = mock.Mock(status_code=200, json=lambda: {"id": "msg-login"})
    with mock.patch("httpx.post", return_value=response) as post:
        result = notifications_services.send_login_code_email(
            email="who@example.com",
            code="123456",
            minutes=15,
            locale="ru",
            provider=ResendEmailProvider(),
        )
    assert result.delivered is True
    payload = post.call_args.kwargs["json"]
    assert payload["to"] == ["who@example.com"]
    assert payload["subject"] == "Код для входа"
    assert "123456" in payload["text"] and "123456" in payload["html"]
    # Срок кода в письме — из аргумента, а не зашитая «5 минут» (замечание
    # владельца 07.09: письмо идёт дольше, чем жил старый код).
    assert "15 минут" in payload["text"] and "15 минут" in payload["html"]
    # Кнопки в сделку и приписки «уведомления можно отключить» здесь нет:
    # ни сделки, ни настройки, которой это письмо выключается, не существует.
    assert "Уведомления можно отключить" not in payload["text"]
    assert "Уведомления можно отключить" not in payload["html"]
    assert "Открыть сделку" not in payload["html"]
    # ADR-172: бренд латиницей и в «от кого», и в шапке письма.
    assert payload["from"] == "Porukam <noreply@porukam.app>"
    assert "Porukam" in payload["html"] and "По рукам" not in payload["html"]


def test_login_code_letter_falls_back_to_english(settings):
    settings.RESEND_API_KEY = "re_key"
    settings.NOTIFICATIONS_EMAIL_FROM = "Porukam <noreply@porukam.app>"
    response = mock.Mock(status_code=200, json=lambda: {"id": "msg-login-2"})
    with mock.patch("httpx.post", return_value=response) as post:
        notifications_services.send_login_code_email(
            email="who@example.com",
            code="654321",
            minutes=15,
            locale=None,
            provider=ResendEmailProvider(),
        )
    payload = post.call_args.kwargs["json"]
    assert payload["subject"] == "Your sign-in code"
    assert "654321" in payload["text"]


def test_login_code_letter_uses_configured_provider_by_default(settings):
    """Без явного provider берётся get_email_provider() — тот же рубильник
    NOTIFICATIONS_EMAIL_PROVIDER, что у уведомлений."""
    settings.NOTIFICATIONS_EMAIL_PROVIDER = "fake"
    result = notifications_services.send_login_code_email(
        email="who@example.com", code="111111", minutes=15, locale="en"
    )
    assert result.delivered is True


def test_login_code_letter_without_address_is_not_delivered():
    result = notifications_services.send_login_code_email(
        email="", code="111111", minutes=15, locale="en", provider=FakeEmailProvider()
    )
    assert result.delivered is False
    assert result.status == "no_email"


def test_login_code_letter_prints_ttl_from_argument():
    """Число минут в письме — параметр, а не константа: apps.accounts
    передаёт его из EMAIL_OTP_CODE_TTL_SECONDS."""
    provider = FakeEmailProvider()
    result = notifications_services.send_login_code_email(
        email="who@example.com", code="222222", minutes=7, locale="en", provider=provider
    )
    assert result.delivered is True
    _address, message = provider.sent[-1]
    assert "7 minutes" in str(message["body"])


def test_login_code_hint_has_minutes_placeholder_in_every_locale():
    """29 локалей ADR-168: срок нигде не зашит числом. Плейсхолдера {code} в
    приписке БОЛЬШЕ НЕТ (ADR-172) — код едет отдельным полем сообщения."""
    assert set(email_texts.LOGIN_CODE_HINT) == set(email_texts.LOGIN_CODE_SUBJECT)
    for locale, template in email_texts.LOGIN_CODE_HINT.items():
        assert "{minutes}" in template, locale
        assert "{code}" not in template, locale
        rendered = email_texts.login_code_hint(locale, minutes=15)
        assert "15" in rendered, locale


def test_login_code_html_shows_code_in_its_own_block(settings):
    """Замечание владельца 08.09 «сделай красивое письмо»: код — отдельная
    крупная плашка, а не часть предложения; фраза под кодом кода НЕ содержит."""
    settings.RESEND_API_KEY = "re_key"
    settings.NOTIFICATIONS_EMAIL_FROM = "Porukam <noreply@porukam.app>"
    settings.PUBLIC_WEB_BASE_URL = "https://porukam.app"
    response = mock.Mock(status_code=200, json=lambda: {"id": "msg-login-3"})
    with mock.patch("httpx.post", return_value=response) as post:
        notifications_services.send_login_code_email(
            email="who@example.com",
            code="424242",
            minutes=15,
            locale="ru",
            provider=ResendEmailProvider(),
        )
    payload = post.call_args.kwargs["json"]
    assert payload["from"] == "Porukam <noreply@porukam.app>"
    html = payload["html"]
    # Плашка кода: крупный моноширинный кегль с разрядкой, код внутри её div.
    block = html.split("Courier New", 1)[1]
    assert "font-size:32px" in block.split("</div>", 1)[0]
    assert ">424242</div>" in block
    # Текст письма — уже без кода, только приписка про срок и «если не вы».
    assert "Код действует 15 минут" in html
    assert "Ваш код для входа: 424242" not in html
    # Превью (preheader) кода не содержит: оно видно на заблокированном экране.
    preheader = html.split("mso-hide:all", 1)[1].split("</div>", 1)[0]
    assert "424242" not in preheader
    # Plain-версия: код отдельной строкой.
    assert "\n424242\n" in payload["text"]
    assert payload["text"].endswith("https://porukam.app")
