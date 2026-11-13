"""Интерфейс платёжного провайдера (tech-spec.md §8.11 `PaymentProvider`,
ADR-055/056; ADR-130).

Спека требует МИНИМУМ ДВУХ партнёров (§15.5, кейс КИВИ) и маршрутизацию
между ними. Договора нет ни с одним, поэтому здесь — только протокол и
`ManualProvider`: «провайдер, которого нет». Он не заглушка-имитация
(`create_payment` не возвращает фейковую платёжную ссылку и не переводит
платёж в `observed`) — он честно сообщает, что деньги идут мимо платформы
и подтверждают их сами стороны.

Регистрация партнёров — через `PROVIDERS`; когда появится Т-Банк, к
словарю добавится строка, а `services`/`api` не меняются.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable


class PaymentProviderUnknownError(ValueError):
    """Провайдер с таким именем не зарегистрирован (`404` на вебхуке)."""


class PaymentProviderNotConfiguredError(ValueError):
    """Способ расчёта требует платёжного партнёра, а его нет (ADR-130):
    `409 payment_provider_not_configured`. Отдельный тип от
    `PaymentProviderUnknownError` — это разные факты: «такого провайдера не
    существует» против «этот способ ждёт партнёра, которого мы не
    подключили»."""


@dataclass(frozen=True, slots=True)
class PaymentFlow:
    """Что клиент должен сделать, чтобы заплатить. У провайдерских способов
    это платёжная ссылка/QR СБП (§8.7); у прямого платежа —
    `kind="two_sided"` и никакой ссылки: платит человек как договорились,
    платформа лишь фиксирует обоюдное подтверждение."""

    kind: str
    payment_url: str | None = None
    details: dict[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class WebhookEvent:
    """Разобранный вебхук: `event_id` — ключ дедупликации (CLAUDE.md:
    «вебхуки идемпотентны»), `payment_ref` — на какую нашу операцию он
    ссылается."""

    event_id: str
    payment_ref: str | None
    outcome: str
    raw: dict[str, Any]


class MalformedWebhookError(ValueError):
    """Тело вебхука не разбирается провайдером (нет `event_id` и т. п.) —
    `422`, не 500: партнёр обязан узнать, что мы не приняли доставку."""


@runtime_checkable
class PaymentProvider(Protocol):
    """tech-spec.md §8.11. `create_payment` — инициация (СБП-сплит без
    комиссии платформы, ADR-055); `parse_webhook` — разбор входящего
    уведомления; `apply_webhook` — доменный эффект (у партнёров: перевод
    платежа в `observed`/`captured`/`failed`)."""

    name: str
    #: Требует ли способ реального партнёра. False только у `manual`.
    requires_partner: bool

    def create_payment(self, *, amount: str, currency: str, reference: str) -> PaymentFlow: ...

    def parse_webhook(self, *, body: dict[str, Any], headers: dict[str, str]) -> WebhookEvent: ...

    def apply_webhook(self, event: WebhookEvent) -> str: ...


class ManualProvider:
    """Прямой платёж без партнёра: деньги между сторонами, платформа
    фиксирует факт (финмодель v2 — «платежи без хранения средств»)."""

    name = "manual"
    requires_partner = False

    def create_payment(self, *, amount: str, currency: str, reference: str) -> PaymentFlow:
        return PaymentFlow(
            kind="two_sided",
            payment_url=None,
            details={"amount": amount, "currency": currency, "reference": reference},
        )

    def parse_webhook(self, *, body: dict[str, Any], headers: dict[str, str]) -> WebhookEvent:
        event_id = str(body.get("event_id") or "").strip()
        if not event_id:
            raise MalformedWebhookError("вебхук без event_id не идемпотентен — отклонён")
        payment_ref = body.get("payment_ref")
        return WebhookEvent(
            event_id=event_id,
            payment_ref=str(payment_ref) if payment_ref else None,
            outcome=str(body.get("outcome") or "unknown"),
            raw=body,
        )

    def apply_webhook(self, event: WebhookEvent) -> str:
        """Никакого эффекта — и это не «TODO». У прямого платежа нет
        внешнего наблюдателя: единственный источник факта оплаты —
        подтверждение обеих сторон. Эндпоинт существует, чтобы контракт и
        дедупликация были готовы к партнёру, а не чтобы что-то делать."""
        return "ignored_no_partner"


PROVIDERS: dict[str, PaymentProvider] = {ManualProvider.name: ManualProvider()}


def get_provider(name: str) -> PaymentProvider:
    try:
        return PROVIDERS[name]
    except KeyError as exc:
        raise PaymentProviderUnknownError(f"провайдер {name!r} не зарегистрирован") from exc
