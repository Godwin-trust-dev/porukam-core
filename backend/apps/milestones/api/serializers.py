from __future__ import annotations

from decimal import Decimal
from typing import Any

from rest_framework import serializers

from .. import selectors
from ..models import ChecklistItem, ContractMaterial, Milestone


class MilestoneCreateSerializer(serializers.Serializer[Any]):
    title = serializers.CharField(max_length=300)
    parent_id = serializers.UUIDField(required=False, allow_null=True, default=None)
    order = serializers.IntegerField(required=False, default=0)
    amount = serializers.DecimalField(
        max_digits=14, decimal_places=2, required=False, allow_null=True, default=None
    )
    currency = serializers.CharField(max_length=3, required=False, allow_null=True, default=None)
    sphere_code = serializers.CharField(
        max_length=64, required=False, allow_null=True, default=None
    )
    deadline = serializers.DateTimeField(required=False, allow_null=True, default=None)
    depends_on_id = serializers.UUIDField(required=False, allow_null=True, default=None)


class MilestonePatchSerializer(serializers.Serializer[Any]):
    title = serializers.CharField(max_length=300, required=False, allow_null=True)
    order = serializers.IntegerField(required=False, allow_null=True)
    amount = serializers.DecimalField(
        max_digits=14, decimal_places=2, required=False, allow_null=True
    )
    currency = serializers.CharField(max_length=3, required=False, allow_null=True)
    sphere_code = serializers.CharField(max_length=64, required=False, allow_null=True)
    deadline = serializers.DateTimeField(required=False, allow_null=True)


class MilestoneSerializer(serializers.ModelSerializer[Milestone]):
    sphere_code = serializers.CharField(source="sphere.code", read_only=True, default=None)
    # ADR-164: пункты чек-листа, которые просят фото и его не получили —
    # ПОДСКАЗКА, а не запрет (гейт сдачи по ним снят). Исполнителю список
    # нужен в диалоге «Сдать этап» мягким предупреждением, заказчику — при
    # приёмке. Возвращается и в ответе `submit`, поэтому остаток непокрытых
    # пунктов виден сразу после сдачи, без второго запроса.
    uncovered_required_evidence = serializers.SerializerMethodField()

    class Meta:
        model = Milestone
        fields = [
            "id",
            "contract_id",
            "parent_id",
            "order",
            "title",
            "status",
            "amount",
            "amount_currency",
            "sphere_code",
            "deadline",
            "depends_on_id",
            "frozen_days",
            "started_at",
            "submitted_at",
            "accepted_at",
            "paid_confirmed_by_customer_at",
            "paid_confirmed_by_contractor_at",
            "created_at",
            "uncovered_required_evidence",
        ]
        read_only_fields = fields

    def get_uncovered_required_evidence(self, obj: Milestone) -> list[str]:
        return [str(item_id) for item_id in selectors.uncovered_required_evidence(obj)]


# --- Э4.6: гейт, сдача, приёмка (docs/tasks/etap-4.md) ----------------------


class MilestoneSubmitSerializer(serializers.Serializer[Any]):
    comment = serializers.CharField(required=False, allow_blank=True, default="")


class MilestoneRejectSerializer(serializers.Serializer[Any]):
    checklist_item_id = serializers.UUIDField(required=False, allow_null=True, default=None)
    evidence = serializers.ListField(child=serializers.CharField(), default=list)


class MaterialProblemNoticeSerializer(serializers.Serializer[Any]):
    reason = serializers.CharField()


class LoanScheduleMaterializeSerializer(serializers.Serializer[Any]):
    currency = serializers.CharField(max_length=3)


# --- Чек-лист -----------------------------------------------------------


class ChecklistItemCreateSerializer(serializers.Serializer[Any]):
    description = serializers.CharField()
    measurable_criterion = serializers.CharField()
    required_evidence = serializers.ListField(child=serializers.CharField(), default=list)
    order = serializers.IntegerField(required=False, default=0)


class ChecklistItemPatchSerializer(serializers.Serializer[Any]):
    description = serializers.CharField(required=False, allow_null=True)
    measurable_criterion = serializers.CharField(required=False, allow_null=True)
    required_evidence = serializers.ListField(
        child=serializers.CharField(), required=False, allow_null=True
    )
    order = serializers.IntegerField(required=False, allow_null=True)


class ChecklistItemSerializer(serializers.ModelSerializer[ChecklistItem]):
    class Meta:
        model = ChecklistItem
        fields = [
            "id",
            "milestone_id",
            "description",
            "measurable_criterion",
            "required_evidence",
            "order",
            "created_at",
        ]
        read_only_fields = fields


class ChecklistRecommendationSerializer(serializers.Serializer[Any]):
    source_template_id = serializers.UUIDField()
    description = serializers.CharField()
    measurable_criterion = serializers.CharField()
    required_evidence = serializers.ListField(child=serializers.CharField())


# --- Материалы ------------------------------------------------------------


class ContractMaterialCreateSerializer(serializers.Serializer[Any]):
    catalog_item_code = serializers.CharField(max_length=64)
    description = serializers.CharField()
    source = serializers.ChoiceField(  # type: ignore[assignment]  # DRF Field.source name clash
        choices=ContractMaterial.Source.choices
    )
    unit_price = serializers.DecimalField(max_digits=14, decimal_places=2)
    unit_price_currency = serializers.CharField(max_length=3)
    external_url = serializers.CharField(required=False, allow_blank=True, default="")
    quantity = serializers.DecimalField(
        max_digits=12, decimal_places=3, required=False, default=Decimal("0")
    )
    unit = serializers.CharField(required=False, allow_blank=True, default="")
    delivery_days = serializers.IntegerField(required=False, min_value=0, default=0)
    delivery_base = serializers.ChoiceField(
        choices=ContractMaterial.DeliveryBase.choices,
        required=False,
        default=ContractMaterial.DeliveryBase.CONTRACT_SIGNING,
    )


class ContractMaterialPatchSerializer(serializers.Serializer[Any]):
    """PATCH /materials/{id} (ADR-155) — те же поля, что у POST, все
    необязательные (`None` = «не менять»). Контракт согласован с фронтом
    (`feat/web-wizard-materials`): окно правки позиции даёт сменить
    наименование из каталога и присылает diff ВСЕХ полей, поэтому
    `catalog_item_code` тоже принимается."""

    catalog_item_code = serializers.CharField(max_length=64, required=False, allow_null=True)
    description = serializers.CharField(required=False, allow_null=True)
    external_url = serializers.CharField(required=False, allow_null=True, allow_blank=True)
    quantity = serializers.DecimalField(
        max_digits=12, decimal_places=3, required=False, allow_null=True
    )
    unit = serializers.CharField(required=False, allow_null=True, allow_blank=True)
    unit_price = serializers.DecimalField(
        max_digits=14, decimal_places=2, required=False, allow_null=True
    )
    unit_price_currency = serializers.CharField(max_length=3, required=False, allow_null=True)
    source = serializers.ChoiceField(  # type: ignore[assignment]  # DRF Field.source name clash
        choices=ContractMaterial.Source.choices, required=False, allow_null=True
    )
    delivery_days = serializers.IntegerField(required=False, min_value=0, allow_null=True)
    delivery_base = serializers.ChoiceField(
        choices=ContractMaterial.DeliveryBase.choices, required=False, allow_null=True
    )


class ContractMaterialSerializer(serializers.ModelSerializer[ContractMaterial]):
    catalog_item_code = serializers.CharField(source="catalog_item.code", read_only=True)

    class Meta:
        model = ContractMaterial
        fields = [
            "id",
            "milestone_id",
            "catalog_item_id",
            "catalog_item_code",
            "description",
            "external_url",
            "quantity",
            "unit",
            "unit_price",
            "unit_price_currency",
            "source",
            "delivery_days",
            "delivery_base",
            # ADR-155: два шага передачи материала — «передано» стороной-
            # источником и «получено» другой стороной.
            "handed_over_at",
            "handed_over_by_id",
            "received",
            "received_at",
            "received_by_id",
            "created_at",
        ]
        read_only_fields = fields
