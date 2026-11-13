"""Сериализаторы apps.payments (tech-spec.md §8.7). Тонкий слой: ни одной
доменной проверки — они в services.py (CLAUDE.md)."""

from __future__ import annotations

from typing import Any

from rest_framework import serializers


class PaymentSerializer(serializers.Serializer[Any]):
    """`GET /v1/payments/{id}`, элемент `GET /v1/contracts/{id}/payments`.

    Строится над словарём `apps.payments.selectors.payment_view`, а не над
    моделью: `my_side`/`confirmed_by_me` зависят от ЗРИТЕЛЯ, а ModelSerializer
    протащил бы request в слой модели (тот же приём, что у
    `apps.dashboards.api.serializers`).

    `amount` — CharField: деньги в API строкой (CLAUDE.md), иначе JSON-число
    теряет копейки на клиенте.
    """

    id = serializers.UUIDField()
    contract_id = serializers.UUIDField()
    milestone_id = serializers.UUIDField()
    milestone_title = serializers.CharField()
    kind = serializers.CharField()
    method = serializers.CharField()
    status = serializers.CharField()
    amount = serializers.CharField()
    currency = serializers.CharField()
    confirmed_by_payer = serializers.BooleanField()
    confirmed_by_payee = serializers.BooleanField()
    payer_confirmed_at = serializers.DateTimeField(allow_null=True)
    payee_confirmed_at = serializers.DateTimeField(allow_null=True)
    cancelled_at = serializers.DateTimeField(allow_null=True)
    cancel_reason = serializers.CharField(allow_blank=True)
    overdue_at = serializers.DateTimeField(allow_null=True)
    provider = serializers.CharField()
    provider_ref = serializers.CharField(allow_null=True)
    my_side = serializers.ChoiceField(choices=["payer", "payee"], allow_null=True)
    confirmed_by_me = serializers.BooleanField(allow_null=True)
    created_at = serializers.DateTimeField()


class PaymentListSerializer(serializers.Serializer[Any]):
    items = PaymentSerializer(many=True)


class PaymentConfirmSerializer(serializers.Serializer[Any]):
    """`{"side": "payer"|"payee"}` — поле объявлено tech-spec.md §8.7 и
    остаётся в контракте, но НЕОБЯЗАТЕЛЬНО: сторона выводится из роли
    вызывающего в договоре, а переданное значение только сверяется с ней
    (403 при расхождении). Подтвердить «за контрагента» нельзя даже с
    правильным телом."""

    side = serializers.ChoiceField(choices=["payer", "payee"], required=False)


class PaymentCancelSerializer(serializers.Serializer[Any]):
    reason = serializers.CharField(required=False, allow_blank=True, max_length=255)


class ConfirmSideSerializer(serializers.Serializer[Any]):
    """Тело унаследованного `POST /milestones/{id}/confirm-payment` — ровно
    то же, что было в apps.milestones.api до переезда контура в
    apps.payments (ADR-130): `side` ОБЯЗАТЕЛЕН и обязан совпадать с ролью
    вызывающего. Контракт фронта не меняется."""

    side = serializers.ChoiceField(choices=["customer", "contractor"])


class WebhookAckSerializer(serializers.Serializer[Any]):
    status = serializers.CharField()
    outcome = serializers.CharField()
