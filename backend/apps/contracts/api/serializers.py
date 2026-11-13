from __future__ import annotations

from datetime import datetime
from typing import Any

from rest_framework import serializers

from apps.catalog.models import ContractTypeCatalogItem
from common.i18n import resolve_request_locale

from .. import forms, selectors
from ..models import (
    Amendment,
    AmendmentChange,
    Contract,
    ContractParty,
    ContractVersion,
    PreapprovedAlternative,
    RevisionProposal,
    Signature,
    SignatureRequest,
)


class ContractCreateSerializer(serializers.Serializer[Any]):
    client_option = serializers.ChoiceField(
        choices=ContractTypeCatalogItem.ClientOption.choices, required=False, allow_null=True
    )
    contract_type_code = serializers.CharField(required=False, allow_null=True, allow_blank=True)
    my_role = serializers.ChoiceField(choices=ContractParty.Role.choices)
    my_acting_as = serializers.ChoiceField(
        choices=ContractParty.ActingAs.choices, default=ContractParty.ActingAs.PERSON
    )
    my_entity_id = serializers.UUIDField(required=False, allow_null=True)
    counterparty_profile_id = serializers.UUIDField(required=False, allow_null=True)
    counterparty_handle = serializers.CharField(required=False, allow_null=True, allow_blank=True)
    payment_method = serializers.ChoiceField(
        choices=Contract.PaymentMethod.choices, required=False, allow_null=True
    )
    # ADR-151: порядок оплаты (срок оплаты этапа) — отдельная ось от
    # payment_method; неприменим к займу (services -> 400
    # payment_order_not_applicable).
    payment_order = serializers.ChoiceField(
        choices=Contract.PaymentOrder.choices, required=False, allow_null=True
    )
    title = serializers.CharField(required=False, allow_blank=True, default="")
    form_data = serializers.JSONField(required=False, default=dict)
    # ADR-167: дополнительные условия — произвольные пункты, введённые
    # вручную в мастере. Тот же список, что копит принятая правка «Другое»
    # (ADR-123). Валидация (непустые строки после trim, длина, число
    # пунктов) — `services.clean_additional_terms`
    # (`AdditionalTermsInvalidError` -> 400 `additional_terms_invalid`).
    additional_terms = serializers.ListField(
        child=serializers.CharField(allow_blank=True, trim_whitespace=False),
        required=False,
        allow_null=True,
    )
    jurisdiction = serializers.CharField(required=False, default="RU", max_length=2)
    source_contract_id = serializers.UUIDField(required=False, allow_null=True)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        has_type = attrs.get("client_option") or attrs.get("contract_type_code")
        has_counterparty = (
            attrs.get("counterparty_profile_id")
            or attrs.get("counterparty_handle")
            or attrs.get("source_contract_id")
        )
        if not has_type and not attrs.get("source_contract_id"):
            raise serializers.ValidationError(
                "нужен client_option или contract_type_code (либо source_contract_id)"
            )
        if not has_counterparty:
            raise serializers.ValidationError(
                "нужен counterparty_profile_id, counterparty_handle или source_contract_id"
            )
        return attrs


class ContractPatchSerializer(serializers.Serializer[Any]):
    client_option = serializers.ChoiceField(
        choices=ContractTypeCatalogItem.ClientOption.choices, required=False, allow_null=True
    )
    contract_type_code = serializers.CharField(required=False, allow_null=True, allow_blank=True)
    my_acting_as = serializers.ChoiceField(
        choices=ContractParty.ActingAs.choices, required=False, allow_null=True
    )
    my_entity_id = serializers.UUIDField(required=False, allow_null=True)
    counterparty_profile_id = serializers.UUIDField(required=False, allow_null=True)
    counterparty_handle = serializers.CharField(required=False, allow_null=True, allow_blank=True)
    payment_method = serializers.ChoiceField(
        choices=Contract.PaymentMethod.choices, required=False, allow_null=True
    )
    # ADR-151: порядок оплаты (срок оплаты этапа) — отдельная ось от
    # payment_method; неприменим к займу (services -> 400
    # payment_order_not_applicable).
    payment_order = serializers.ChoiceField(
        choices=Contract.PaymentOrder.choices, required=False, allow_null=True
    )
    title = serializers.CharField(required=False, allow_blank=True, allow_null=True)
    form_data = serializers.JSONField(required=False, allow_null=True)
    # ADR-167: дополнительные условия — произвольные пункты, введённые
    # вручную в мастере. Тот же список, что копит принятая правка «Другое»
    # (ADR-123). Валидация (непустые строки после trim, длина, число
    # пунктов) — `services.clean_additional_terms`
    # (`AdditionalTermsInvalidError` -> 400 `additional_terms_invalid`).
    additional_terms = serializers.ListField(
        child=serializers.CharField(allow_blank=True, trim_whitespace=False),
        required=False,
        allow_null=True,
    )
    # Л.1 (docs/tasks/l10n-wave.md, уточнение к доку 32 v1.2) — явный выбор
    # официального языка договора; PATCH-only, нет мастера выбора при
    # создании. Валидация (quality >= reviewed) — services.patch_draft
    # (LanguageNotEligibleError -> 422).
    language = serializers.CharField(required=False, allow_null=True, max_length=8)


class ContractTerminateSerializer(serializers.Serializer[Any]):
    """POST /contracts/{id}/terminate-by-customer|contractor (etap-4.md
    Э4.6 — заглушка эндпоинтов, `reason` не валидируется по существу, окно
    оспаривания основания — этап 7)."""

    reason = serializers.CharField(required=False, allow_blank=True, default="")


class ContractPartySerializer(serializers.ModelSerializer[ContractParty]):
    class Meta:
        model = ContractParty
        fields = ["id", "role", "profile_id", "entity_id", "acting_as"]
        read_only_fields = fields


class ContractSerializer(serializers.ModelSerializer[Contract]):
    contract_type_code = serializers.CharField(source="contract_type_id")
    parties = ContractPartySerializer(many=True, read_only=True)
    # П-16 (etap-4-delta-p16.md п.3, п.5): предупреждения по текущему
    # form_data — типовые (схема) + кросс-типовые; не блокируют сохранение,
    # только сопровождают ответ.
    warnings = serializers.SerializerMethodField()
    # Л.1 (docs/tasks/l10n-wave.md, уточнение к доку 32 v1.2) — явный override
    # официального языка (пусто, если не выставлен PATCH'ем — тогда язык
    # решает авторезолв при заморозке, ContractVersion.official_language).
    language = serializers.CharField(source="language_override")
    # docs/tasks/Задача_redesign_contracts-execution-flow-real-api.md, ADR-088
    # («Фаза 0» — дешёвые добавления без миграций): total/initiator_role
    # раньше не отдавались вовсе, хотя обе величины уже вычислимы.
    total = serializers.SerializerMethodField()
    initiator_role = serializers.SerializerMethodField()
    # ADR-138: дата автозакрытия сделки без движения (null вне `in_progress`).
    idle_deadline_at = serializers.SerializerMethodField()
    # ADR-158: отметка «материалы просмотрены» СВОЕЙ стороны (чужую не
    # отдаём) — от неё фронт решает, показывать ли бейдж «Материалы изменены
    # контрагентом» на любом устройстве, а не только на том, где кликнули.
    materials_seen_at = serializers.SerializerMethodField()

    class Meta:
        model = Contract
        fields = [
            "id",
            "contract_type_code",
            "deal_type",
            "segment",
            "negotiation_status",
            "execution_status",
            "payment_method",
            # ADR-151: порядок оплаты (`null` — не выбран / неприменим).
            "payment_order",
            "protected",
            "uses_platform_template",
            "jurisdiction",
            "title",
            "form_data",
            # ADR-123/ADR-167: дополнительные условия — ручной ввод в мастере
            # (PATCH черновика) плюс принятые правки «Другое», один список.
            "additional_terms",
            "warnings",
            "language",
            "parties",
            "total",
            "initiator_role",
            # id текущей заморозки (FK-attname -> ReadOnlyField, тот же приём,
            # что у AmendmentSerializer): `null` на черновике и после
            # decline_for_revision (services.py снимает `frozen_version`).
            # Раньше фронт выуживал id из timeline-события `negotiation.frozen`
            # (SigningPage.tsx, ADR-088) — хрупко при пагинации хроники.
            "frozen_version_id",
            "created_at",
            # ADR-138: последнее движение по договору и дата автозакрытия.
            "last_activity_at",
            "idle_deadline_at",
            # ADR-158: см. поле выше.
            "materials_seen_at",
        ]
        read_only_fields = fields

    def get_idle_deadline_at(self, obj: Contract) -> Any:  # noqa: ANN401
        return selectors.idle_deadline_at(obj)

    def get_materials_seen_at(self, obj: Contract) -> datetime | None:
        """Отметка СМОТРЯЩЕГО. Без request в context (прямые вызовы вне view,
        тот же случай, что у `get_warnings`) — `None`: чью отметку отдавать,
        неизвестно."""
        request = self.context.get("request")
        user = getattr(request, "user", None)
        if user is None or not user.is_authenticated:
            return None
        return selectors.materials_seen_at(obj, user)

    def get_warnings(self, obj: Contract) -> list[dict[str, str]]:
        # Наружу — {field, code, message} с текстом на языке запроса (отсмотр
        # 2026-08-19: фронт читает w.message, ключи давали пустые буллеты).
        # Без request в context (прямые вызовы вне view) — ru, как detail ошибок.
        request = self.context.get("request")
        locale = resolve_request_locale(request) if request is not None else "ru"
        return [forms.localize_warning(w, locale=locale) for w in forms.compute_form_warnings(obj)]

    def get_total(self, obj: Contract) -> dict[str, str] | None:
        """«Сумма листьев = сумма договора» (tech-spec.md §6.1) — схема НЕ
        хранит отдельного «объявленного» итога, дерево этапов И ЕСТЬ сумма
        (`apps.milestones.services.total_leaf_amount`). `None` — на черновике
        без единого этапа (до `Задача_feat_catalog-real-api.md`/мастера
        создания это норма, не ошибка). Отложенный импорт apps.milestones —
        см. `services.freeze` в этом же приложении, тот же цикл-риск."""
        from apps.milestones import services as milestones_services

        try:
            total = milestones_services.total_leaf_amount(obj)
        except ValueError:
            return None
        return {"amount": str(total.amount), "currency": total.currency}

    def get_initiator_role(self, obj: Contract) -> str | None:
        return selectors.initiator_role(obj)


class MaterialsSeenSerializer(serializers.Serializer[Any]):
    """POST /contracts/{id}/materials-seen (ADR-158) — тело необязательно.
    `seen_at` — момент правки материалов, которую сторона фактически увидела
    (фронт берёт его из хроники договора); без него отметка ставится на
    «сейчас». Сервис зажимает значение текущим временем и не двигает отметку
    назад — эндпоинт идемпотентен по построению."""

    seen_at = serializers.DateTimeField(required=False, allow_null=True, default=None)


class MaterialsSeenStateSerializer(serializers.Serializer[Any]):
    """Ответ отметки — только сама отметка, без тяжёлого ContractSerializer
    (тот считает `warnings` и `total` по дереву этапов; ради булева «видел» в
    карточке это лишняя работа на каждый показ блока материалов)."""

    materials_seen_at = serializers.DateTimeField(allow_null=True)


# --- Э4.2: протокол разногласий ------------------------------------------


class RevisionProposalCreateSerializer(serializers.Serializer[Any]):
    item_ref = serializers.CharField(max_length=200)
    new_value = serializers.JSONField()
    old_value = serializers.JSONField(required=False, allow_null=True, default=None)
    comment = serializers.CharField(required=False, allow_blank=True, default="")


class RevisionProposalCounterSerializer(serializers.Serializer[Any]):
    new_value = serializers.JSONField()
    comment = serializers.CharField(required=False, allow_blank=True, default="")


class RevisionProposalSerializer(serializers.ModelSerializer[RevisionProposal]):
    class Meta:
        model = RevisionProposal
        fields = [
            "id",
            "contract_id",
            "item_ref",
            "old_value",
            "new_value",
            "comment",
            "proposed_by_id",
            "status",
            "decided_by_id",
            "decided_at",
            "preapproved_alternative_of_id",
            "created_at",
        ]
        read_only_fields = fields


class AcceptAllRevisionsSerializer(serializers.Serializer[Any]):
    confirm_summary = serializers.BooleanField(required=False, default=False)


class PreapprovedAlternativeCreateSerializer(serializers.Serializer[Any]):
    item_ref = serializers.CharField(max_length=200)
    payload = serializers.JSONField()


class PreapprovedAlternativeSerializer(serializers.ModelSerializer[PreapprovedAlternative]):
    class Meta:
        model = PreapprovedAlternative
        fields = ["id", "contract_id", "item_ref", "payload", "created_by_id", "created_at"]
        read_only_fields = fields


class TimelineSubjectSerializer(serializers.Serializer[Any]):
    """`subject` элемента хроники (ADR-134): `type` — contract / milestone /
    amendment / dispute / payment / warranty_claim, `id` — для ссылки,
    `title` — подпись сущности, если издатель положил её в событие
    (`milestone_title`), иначе `null`."""

    type = serializers.CharField(allow_null=True)
    id = serializers.CharField(allow_null=True)
    title = serializers.CharField(allow_null=True)


class TimelineEventSerializer(serializers.Serializer[Any]):
    """Элемент `GET /contracts/{id}/timeline` и `/amendments/{id}/timeline`
    (tech-spec.md §6.4a, ADR-134). `topic`/`payload` — как в outbox
    (совместимость); `kind` — стабильный ключ представления
    (`events.timeline_kind`, реестр `events.TIMELINE_KINDS`); `title`/`detail`
    — подпись на языке запроса из l10n-паков (`ui.timeline.<kind>`, фронт не
    переводит; нет текста — `null`); `nested` — событие дочерней сущности, показывается свёрнуто."""

    event_id = serializers.UUIDField()
    topic = serializers.CharField()
    kind = serializers.CharField()
    title = serializers.CharField(allow_null=True)
    detail = serializers.CharField(allow_null=True)
    nested = serializers.BooleanField()
    occurred_at = serializers.DateTimeField()
    actor = serializers.JSONField()
    subject = TimelineSubjectSerializer()
    payload = serializers.JSONField()


# --- Э4.4: заморозка и подписание --------------------------------------------


class ContractVersionSerializer(serializers.ModelSerializer[ContractVersion]):
    # Л.1 (docs/tasks/l10n-wave.md, уточнение к доку 32 v1.2) — API-тексты не
    # несут слово "canonical" (продуктовая формулировка "official"), модель
    # хранит поле как `canonical_language` (историческое имя из постановки
    # п.1) — источник тот же, наружу отдаётся под другим именем.
    official_language = serializers.CharField(source="canonical_language")

    class Meta:
        model = ContractVersion
        fields = [
            "id",
            "contract_id",
            "snapshot",
            "integrity_hash",
            "hash_algorithm",
            "frozen_at",
            "trusted_timestamp_source",
            "trusted_timestamp_at",
            # Не входят в integrity_hash (ADR-078).
            "official_language",
            "renders",
        ]
        read_only_fields = fields


class SignatoryOptionSerializer(serializers.Serializer[Any]):
    user_id = serializers.UUIDField()
    basis = serializers.CharField()


class SignatureRequestCreateSerializer(serializers.Serializer[Any]):
    side = serializers.ChoiceField(choices=ContractParty.Role.choices)
    version_id = serializers.UUIDField()
    signatory_user_id = serializers.UUIDField()
    comment = serializers.CharField(required=False, allow_blank=True, default="")


class SignatureRequestSerializer(serializers.ModelSerializer[SignatureRequest]):
    """`signed_at` — момент подписи по этому запросу (26.08, экран допника
    показывает время ЧУЖОЙ подписи): у самого запроса такого поля нет, оно
    у `Signature` того же раунда (contract + amendment + side); до подписи
    и после аннулирования раунда (подписи удалены) — null."""

    signed_at = serializers.SerializerMethodField()

    class Meta:
        model = SignatureRequest
        fields = [
            "id",
            "contract_id",
            "amendment_id",
            "version_id",
            "side",
            "routed_by_id",
            "signatory_id",
            "status",
            "sent_at",
            "expires_at",
            "signed_at",
            "comment",
            # Л.1 (docs/tasks/l10n-wave.md, п.4) — locale показанного рендера,
            # пусто до подписания (services.sign проставляет).
            "locale",
        ]
        read_only_fields = fields

    def get_signed_at(self, obj: SignatureRequest) -> str | None:
        if obj.status != SignatureRequest.Status.SIGNED:
            return None
        signatures = Signature.objects.filter(contract_id=obj.contract_id, side=obj.side)
        if obj.amendment_id is None:
            signatures = signatures.filter(amendment__isnull=True)
        else:
            signatures = signatures.filter(amendment_id=obj.amendment_id)
        signature = signatures.order_by("-signed_at").first()
        return signature.signed_at.isoformat() if signature is not None else None


class SignRequestSerializer(serializers.Serializer[Any]):
    version_hash = serializers.CharField(max_length=64)
    # Р1: провайдер УНЭП/Госключ не подключён (JurisdictionConfig, задел на
    # будущее) — esign принимается, но не валидируется и не сохраняется.
    esign = serializers.JSONField(required=False, default=dict)


class SignatureSerializer(serializers.ModelSerializer[Signature]):
    class Meta:
        model = Signature
        fields = [
            "id",
            "contract_id",
            "amendment_id",
            "version_hash",
            "side",
            "signatory_id",
            "signed_at",
            "signature_basis",
        ]
        read_only_fields = fields


class ForwardSignatureRequestSerializer(serializers.Serializer[Any]):
    comment = serializers.CharField(required=False, allow_blank=True, default="")


class DeclineForRevisionSerializer(serializers.Serializer[Any]):
    comment = serializers.CharField(max_length=2000)


class ReturnForRevisionSerializer(serializers.Serializer[Any]):
    """ADR-124: комментарий обязателен и непуст (CharField без allow_blank)."""

    comment = serializers.CharField(max_length=2000)


class AmendmentCloseSerializer(serializers.Serializer[Any]):
    """POST /amendments/{id}/withdraw|reject (26.08, ADR-075): причина
    необязательна — уходит в payload события и в хронику допника."""

    reason = serializers.CharField(required=False, allow_blank=True, default="", max_length=2000)


# --- Э4.5: допники ------------------------------------------------------


class AmendmentChangeCreateSerializer(serializers.Serializer[Any]):
    type = serializers.ChoiceField(choices=AmendmentChange.Type.choices)
    target = serializers.UUIDField(required=False, allow_null=True, default=None)
    payload = serializers.JSONField(required=False, default=dict)


class AmendmentCreateSerializer(serializers.Serializer[Any]):
    reason = serializers.CharField()
    changes = AmendmentChangeCreateSerializer(many=True)
    custom_terms = serializers.CharField(required=False, allow_blank=True, default="")


class AmendmentUpdateSerializer(serializers.Serializer[Any]):
    """PATCH /amendments/{id} (ADR-161): та же форма, что при создании —
    `changes` заменяется ЦЕЛИКОМ, поэтому список обязателен так же, как в
    `AmendmentCreateSerializer` (пустой список = допник без изменений,
    это законный черновик)."""

    reason = serializers.CharField()
    changes = AmendmentChangeCreateSerializer(many=True)
    custom_terms = serializers.CharField(required=False, allow_blank=True, default="")


class AmendmentChangeSerializer(serializers.ModelSerializer[AmendmentChange]):
    class Meta:
        model = AmendmentChange
        fields = [
            "id",
            "type",
            "target",
            "payload",
            "amount_delta",
            "amount_delta_currency",
            "days_delta",
            "created_at",
        ]
        read_only_fields = fields


class AmendmentSerializer(serializers.ModelSerializer[Amendment]):
    # tech-spec.md §8.6: «Карточка — изменения, вычисленные amount_delta,
    # days_delta» — переиспользует apps.contracts.services.
    # compute_amendment_deltas (не пересчитывает сама, ту же функцию, что
    # canonical-снимок при заморозке).
    changes = AmendmentChangeSerializer(many=True, read_only=True)
    amount_delta = serializers.SerializerMethodField()
    days_delta = serializers.SerializerMethodField()

    class Meta:
        model = Amendment
        fields = [
            "id",
            "contract_id",
            "order",
            "reason",
            "custom_terms",
            "negotiation_status",
            "frozen_version_id",
            "created_by_id",
            "created_at",
            "changes",
            "amount_delta",
            "days_delta",
        ]
        read_only_fields = fields

    def get_amount_delta(self, obj: Amendment) -> dict[str, str] | None:
        from .. import services

        total, _days = services.compute_amendment_deltas(obj)
        return {"amount": str(total.amount), "currency": total.currency} if total else None

    def get_days_delta(self, obj: Amendment) -> int:
        from .. import services

        _amount, days = services.compute_amendment_deltas(obj)
        return days
