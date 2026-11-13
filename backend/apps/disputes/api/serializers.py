"""Сериализаторы apps.disputes (tech-spec.md §8.8). Тонкий слой: бизнес-логика
— в services.py, чтение — в selectors.py (CLAUDE.md §Архитектура).

Суммы — СТРОКОЙ (CLAUDE.md: «суммы в API — строкой»), валюта всегда рядом.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from rest_framework import serializers

from .. import selectors, services
from ..models import (
    MAX_FIX_ROUNDS,
    DiscountAgreement,
    Dispute,
    DisputeReply,
    DisputeWindow,
    FixRequest,
)


class FixRequestSerializer(serializers.ModelSerializer[FixRequest]):
    class Meta:
        model = FixRequest
        fields = [
            "id",
            "round",
            "requested_by_id",
            "comment",
            "requested_at",
            "resubmitted_by_id",
            "resubmit_comment",
            "resubmitted_at",
        ]
        read_only_fields = fields


class DisputeReplySerializer(serializers.ModelSerializer[DisputeReply]):
    """Реплика `POST /disputes/{id}/respond` — карточка спора показывает,
    ЧТО ответила сторона, а не только факт «окно оспорено»."""

    class Meta:
        model = DisputeReply
        fields = ["id", "author_id", "comment", "evidence", "created_at"]
        read_only_fields = fields


class DiscountAgreementSerializer(serializers.ModelSerializer[DiscountAgreement]):
    """`amendment_id` — вход в ОБЩИЙ контур подписания §8.6: принятие скидки
    = подпись допника, отдельной кнопки «принять» в споре нет (ADR-131)."""

    old_amount = serializers.DecimalField(max_digits=14, decimal_places=2, coerce_to_string=True)
    new_amount = serializers.DecimalField(max_digits=14, decimal_places=2, coerce_to_string=True)

    class Meta:
        model = DiscountAgreement
        fields = [
            "id",
            "amendment_id",
            "milestone_id",
            "proposed_by_id",
            "old_amount",
            "old_amount_currency",
            "new_amount",
            "new_amount_currency",
            "anti_waiver_note",
            "status",
            "decided_by_id",
            "decided_at",
            "created_at",
        ]
        read_only_fields = fields


class DisputeWindowSerializer(serializers.ModelSerializer[DisputeWindow]):
    """ADR-019. `deadline_at` — null, пока уведомление не размещено в ЛК
    (ADR-057: окно не тикает до юридической доставки)."""

    class Meta:
        model = DisputeWindow
        fields = [
            "id",
            "kind",
            "contract_id",
            "dispute_id",
            "subject_ref",
            "opened_at",
            "deadline_at",
            "contested",
            "contested_by_id",
            "contested_at",
            "closed_at",
        ]
        read_only_fields = fields


class DisputeSerializer(serializers.ModelSerializer[Dispute]):
    """`counterparty` — `{profile_id, display_name, role, avatar_url}` ВТОРОЙ
    стороны относительно читателя (отсмотр 25.08: фронт брал её из кэша
    `GET /contracts`). Требует `context["request"]` — вьюхи его передают; из
    него же берётся зритель для фото (ADR-173/ADR-103)."""

    contract_id = serializers.UUIDField(read_only=True)
    counterparty = serializers.SerializerMethodField()
    days_to_cap = serializers.SerializerMethodField()
    fix_rounds_left = serializers.SerializerMethodField()
    fix_requests = FixRequestSerializer(many=True, read_only=True)
    replies = DisputeReplySerializer(many=True, read_only=True)
    discount_agreements = DiscountAgreementSerializer(many=True, read_only=True)
    windows = DisputeWindowSerializer(many=True, read_only=True)

    class Meta:
        model = Dispute
        fields = [
            "id",
            "kind",
            "milestone_id",
            "contract_id",
            "checklist_item_id",
            "opened_by_id",
            "counterparty",
            "evidence",
            "status",
            "fix_rounds_used",
            "fix_rounds_left",
            "resolution_type",
            "outcome",
            "opened_at",
            "cap_deadline_at",
            "days_to_cap",
            "resolved_at",
            "fix_requests",
            "replies",
            "discount_agreements",
            "windows",
        ]
        read_only_fields = fields

    def get_counterparty(self, obj: Dispute) -> dict[str, Any] | None:
        request = self.context.get("request")
        if request is None or not request.user.is_authenticated:
            return None
        return selectors.counterparty_snapshot(obj, user=request.user, request=request)

    def get_days_to_cap(self, obj: Dispute) -> int | None:
        return services.days_to_cap(obj)

    def get_fix_rounds_left(self, obj: Dispute) -> int:
        return max(MAX_FIX_ROUNDS - obj.fix_rounds_used, 0)


class DisputeResolveSerializer(serializers.Serializer[Any]):
    """`POST /disputes/{id}/resolve` — закрытие ПО СОГЛАСИЮ сторон либо
    передача в суд. Системные исходы (`cap_reached` — свип потолка,
    `discount_accepted` — подписанный допник) через API не принимаются:
    их источник — событие, а не кнопка."""

    resolution_type = serializers.ChoiceField(
        choices=[
            "accepted",
            "withdrawn",
            "escalated_to_court",
            "warranty_satisfied",
            "warranty_declined",
        ]
    )


class DisputeRespondSerializer(serializers.Serializer[Any]):
    comment = serializers.CharField(allow_blank=True, default="")
    evidence = serializers.ListField(child=serializers.CharField(), required=False, default=list)


class DisputeWindowContestSerializer(serializers.Serializer[Any]):
    comment = serializers.CharField(allow_blank=True, default="")


class FixRequestCreateSerializer(serializers.Serializer[Any]):
    comment = serializers.CharField(allow_blank=True, default="")


class FixResubmitSerializer(serializers.Serializer[Any]):
    comment = serializers.CharField(allow_blank=True, default="")


class DiscountProposalSerializer(serializers.Serializer[Any]):
    """`new_amount` — строкой (CLAUDE.md), валюта обязательна отдельно:
    валюты по умолчанию нет нигде. `anti_waiver_note` обязателен — у §20.3
    («скидка закрывает только указанный дефект») нет дефолтного текста:
    формулировка юрзначима и приходит от стороны."""

    new_amount = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=Decimal("0"))
    currency = serializers.CharField(min_length=3, max_length=3)
    anti_waiver_note = serializers.CharField()
    reason = serializers.CharField(allow_blank=True, default="")


class DiscountDeclineSerializer(serializers.Serializer[Any]):
    """`POST /disputes/{id}/discount-proposals/{did}/decline` — комментарий
    отказа: уходит в payload `dispute.discount_declined` и становится
    `reason` автоматического отклонения допника скидки (дополнение 26.08 к
    ADR-131). Тело необязательно — пустой POST по-прежнему валиден."""

    comment = serializers.CharField(allow_blank=True, default="")
