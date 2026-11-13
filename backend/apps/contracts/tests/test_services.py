"""apps.contracts.services — Э4.1 (docs/tasks/etap-4.md).

compute_segment сам по себе (все ветви ADR-058) уже покрыт
apps.catalog.tests.test_services — здесь НЕ дублируется (CLAUDE.md,
etap-4.md общие требования: «тесты compute_segment из feat/catalog-v2
переиспользовать, не дублировать»). Здесь тестируется ТОЛЬКО проводка
apps.contracts к этой функции: резолв сторон, вычисление deal_type/segment
для конкретного договора, PATCH-пересчёт, отказы резолва контрагента.
"""

from __future__ import annotations

import uuid

import pytest

from apps.accounts import services as accounts_services
from apps.accounts.models import User
from apps.catalog import services as catalog_services
from apps.contracts import services
from apps.contracts.models import Contract, ContractParty
from apps.entities.models import BusinessEntity
from apps.profiles import services as profiles_services
from apps.profiles.models import Profile
from apps.social import services as social_services

pytestmark = pytest.mark.django_db

_ROLE = ContractParty.Role
_ACTING_AS = ContractParty.ActingAs


def _user(suffix: str) -> User:
    return User.objects.create(trust_id=f"trust-contracts-svc-{suffix}", phone=f"+7999085{suffix}")


@pytest.fixture
def customer() -> User:
    return _user("0001")


@pytest.fixture
def contractor() -> User:
    return _user("0002")


# --- создание: сегментация services_individual/services_business (приёмка Э4.1) ---


def test_create_draft_service_individual_is_free_c2c(customer: User, contractor: User):
    contractor_profile = Profile.objects.create(
        kind=Profile.Kind.PERSON,
        owner_user=contractor,
        profile_visibility=Profile.Visibility.LINK_AND_DEALS,
    )
    contract = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        client_option="service",
        counterparty_profile_id=contractor_profile.id,
        payment_method=Contract.PaymentMethod.CASH,
        title="Ремонт крана",
    )
    assert contract.contract_type_id == "services_individual"
    assert contract.segment == "free_c2c"
    assert contract.deal_type == Contract.DealType.C2C
    assert contract.negotiation_status == Contract.NegotiationStatus.DRAFT


def test_create_draft_service_business_contractor_is_paid_business(
    customer: User, contractor: User
):
    accounts_services.set_business_status(contractor, True)
    contractor_profile = Profile.objects.create(
        kind=Profile.Kind.PERSON,
        owner_user=contractor,
        profile_visibility=Profile.Visibility.LINK_AND_DEALS,
    )
    contract = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        client_option="service",
        counterparty_profile_id=contractor_profile.id,
        payment_method=Contract.PaymentMethod.CASH,
        title="Разработка сайта",
    )
    assert contract.contract_type_id == "services_business"
    assert contract.segment == "paid_business"
    party_map = {p.role: p for p in contract.parties.all()}
    assert party_map[_ROLE.CONTRACTOR].acting_as == _ACTING_AS.PERSON
    assert party_map[_ROLE.CONTRACTOR].entity_id is None


def test_create_draft_contractor_acting_as_business_via_entity_is_paid_business(
    customer: User, contractor: User
):
    entity = BusinessEntity.objects.create(
        country_of_registration="RU",
        local_form_code="ru_ooo",
        name="ООО Подрядчик",
        created_by=contractor,
        claim_status=BusinessEntity.ClaimStatus.CLAIMED,
        claimed_by=contractor,
    )
    Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=customer, profile_visibility="link_and_deals"
    )
    contract = services.create_draft(
        user=contractor,
        my_role=_ROLE.CONTRACTOR,
        my_acting_as=_ACTING_AS.BUSINESS,
        my_entity_id=entity.id,
        contract_type_code="services_business",
        counterparty_handle=_claim_handle(customer, "zakazchik1"),
        payment_method=Contract.PaymentMethod.CASH,
    )
    assert contract.segment == "paid_business"
    party_map = {p.role: p for p in contract.parties.all()}
    assert party_map[_ROLE.CONTRACTOR].entity_id == entity.id
    assert party_map[_ROLE.CONTRACTOR].acting_as == _ACTING_AS.BUSINESS


# --- excluded / not_yet_supported — проброс исключений apps.catalog без изменений ---


def test_create_draft_excluded_type_raises(customer: User, contractor: User):
    contractor_profile = Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=contractor, profile_visibility="link_and_deals"
    )
    with pytest.raises(catalog_services.ContractTypeExcludedError):
        services.create_draft(
            user=customer,
            my_role=_ROLE.CUSTOMER,
            contract_type_code="shares_securities",
            counterparty_profile_id=contractor_profile.id,
        )


def test_create_draft_sale_vehicle_is_not_yet_supported(customer: User, contractor: User):
    """Приёмка Э4.1: «Продажа» с предметом-авто -> 409 «этот тип сделки
    скоро» (api/ переводит это исключение в 409, здесь — сервисный слой)."""
    contractor_profile = Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=contractor, profile_visibility="link_and_deals"
    )
    with pytest.raises(catalog_services.ContractTypeNotYetSupportedError):
        services.create_draft(
            user=customer,
            my_role=_ROLE.CUSTOMER,
            contract_type_code="sale_vehicle",
            counterparty_profile_id=contractor_profile.id,
        )


def test_create_draft_sale_requires_explicit_code(customer: User, contractor: User):
    """«Продажа» (в отличие от «Услуги») не резолвится автоматически —
    нужен явный contract_type_code (etap-4.md Э4.1)."""
    contractor_profile = Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=contractor, profile_visibility="link_and_deals"
    )
    with pytest.raises(services.ClientOptionRequiresExplicitCodeError):
        services.create_draft(
            user=customer,
            my_role=_ROLE.CUSTOMER,
            client_option="sale",
            counterparty_profile_id=contractor_profile.id,
        )


# --- Р-1 (CLAUDE.md, обязательный тест): представитель чужого ООО --------


def test_director_of_foreign_llc_personal_service_is_free_c2c(customer: User, contractor: User):
    """`contractor` — director чужого ООО (не claimed_by), но заключает
    договор ЛИЧНО как физлицо: apps.entities.services.try_auto_claim
    выставляет has_business_status только по owner-match (собственный
    СМЗ/ИП), директорство чужого юрлица его не трогает, поэтому сегмент —
    free_c2c, а не paid_business."""
    someone_else = _user("0009")
    BusinessEntity.objects.create(
        country_of_registration="RU",
        local_form_code="ru_ooo",
        name="Чужое ООО",
        created_by=someone_else,
        director_user=contractor,
        director_full_name="Иванов Иван Иванович",
    )
    assert contractor.has_business_status is False

    contractor_profile = Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=contractor, profile_visibility="link_and_deals"
    )
    contract = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        client_option="service",
        counterparty_profile_id=contractor_profile.id,
    )
    assert contract.contract_type_id == "services_individual"
    assert contract.segment == "free_c2c"


# --- deal_type -------------------------------------------------------------


def test_deal_type_c2c_when_both_parties_are_persons(customer: User, contractor: User):
    contractor_profile = Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=contractor, profile_visibility="link_and_deals"
    )
    contract = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        contract_type_code="loan_individuals",
        counterparty_profile_id=contractor_profile.id,
    )
    assert contract.deal_type == Contract.DealType.C2C


def test_deal_type_b2c_when_one_party_is_business(customer: User, contractor: User):
    entity = BusinessEntity.objects.create(
        country_of_registration="RU",
        local_form_code="ru_ooo",
        name="ООО Подрядчик",
        created_by=contractor,
        claim_status=BusinessEntity.ClaimStatus.CLAIMED,
        claimed_by=contractor,
    )
    Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=customer, profile_visibility="link_and_deals"
    )
    contract = services.create_draft(
        user=contractor,
        my_role=_ROLE.CONTRACTOR,
        my_acting_as=_ACTING_AS.BUSINESS,
        my_entity_id=entity.id,
        contract_type_code="services_business",
        counterparty_handle=_claim_handle(customer, "zakazchik2"),
    )
    assert contract.deal_type == Contract.DealType.B2C


def test_deal_type_b2b_when_both_parties_are_business(customer: User, contractor: User):
    customer_entity = BusinessEntity.objects.create(
        country_of_registration="RU",
        local_form_code="ru_ooo",
        name="ООО Заказчик",
        created_by=customer,
        claim_status=BusinessEntity.ClaimStatus.CLAIMED,
        claimed_by=customer,
    )
    contractor_entity = BusinessEntity.objects.create(
        country_of_registration="RU",
        local_form_code="ru_ooo",
        name="ООО Подрядчик",
        created_by=contractor,
        claim_status=BusinessEntity.ClaimStatus.CLAIMED,
        claimed_by=contractor,
    )
    contractor_profile = profiles_services.get_or_create_business_profile(contractor_entity)
    contract = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        my_acting_as=_ACTING_AS.BUSINESS,
        my_entity_id=customer_entity.id,
        contract_type_code="services_business",
        counterparty_profile_id=contractor_profile.id,
    )
    assert contract.deal_type == Contract.DealType.B2B


# --- protected по способу расчёта ------------------------------------------


@pytest.mark.parametrize(
    ("payment_method", "expected"),
    [
        (Contract.PaymentMethod.DIRECT_PLATFORM, True),
        (Contract.PaymentMethod.HOLD, True),
        (Contract.PaymentMethod.CASH, False),
        (Contract.PaymentMethod.EXTERNAL, False),
        (None, False),
    ],
)
def test_protected_follows_payment_method(
    customer: User, contractor: User, payment_method, expected
):
    contractor_profile = Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=contractor, profile_visibility="link_and_deals"
    )
    contract = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        contract_type_code="loan_individuals",
        counterparty_profile_id=contractor_profile.id,
        payment_method=payment_method,
    )
    assert contract.protected is expected


# --- резолв контрагента: profile_id / handle / отказы ----------------------


def _claim_handle(user: User, value: str) -> str:
    social_services.claim_handle(user=user, value=value)
    return value


def test_counterparty_by_handle_resolves_to_person_profile(customer: User, contractor: User):
    Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=contractor, profile_visibility="link_and_deals"
    )
    handle = _claim_handle(contractor, "master_ivan")
    contract = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        contract_type_code="loan_individuals",
        counterparty_handle=handle,
    )
    party = contract.parties.get(role=_ROLE.CONTRACTOR)
    assert party.profile.owner_user_id == contractor.id


def test_counterparty_handle_with_at_prefix_resolves_and_reports_single_at(customer: User):
    """Фронт шлёт хендл С «@» (HandleEntry, ADR-092): резолв обязан работать,
    а тексты ошибок — печатать один «@», не «@@» (§E-смоук 2026-08-18):
    у пользователя есть хендл, но НЕТ профиля (шаг приватности не завершён)."""
    contractor = _user("0042")
    _claim_handle(contractor, "no_profile_yet")
    with pytest.raises(services.CounterpartyNotFoundError) as exc_info:
        services.create_draft(
            user=customer,
            my_role=_ROLE.CUSTOMER,
            contract_type_code="loan_individuals",
            counterparty_handle="@no_profile_yet",
        )
    assert "@no_profile_yet" in str(exc_info.value)
    assert "@@" not in str(exc_info.value)


def test_counterparty_by_unknown_handle_not_found(customer: User):
    with pytest.raises(services.CounterpartyNotFoundError):
        services.create_draft(
            user=customer,
            my_role=_ROLE.CUSTOMER,
            contract_type_code="loan_individuals",
            counterparty_handle="nobody-here",
        )


def test_counterparty_handle_belonging_to_group_is_rejected(customer: User):
    leader = _user("0010")
    social_services.create_group(
        leader, kind="community", name="Мастера ремонта", handle="masters_group", sphere_code="it"
    )
    with pytest.raises(services.CounterpartyIsGroupError):
        services.create_draft(
            user=customer,
            my_role=_ROLE.CUSTOMER,
            contract_type_code="loan_individuals",
            counterparty_handle="masters_group",
        )


def test_counterparty_unknown_profile_id_not_found(customer: User):
    with pytest.raises(services.CounterpartyNotFoundError):
        services.create_draft(
            user=customer,
            my_role=_ROLE.CUSTOMER,
            contract_type_code="loan_individuals",
            counterparty_profile_id=uuid.uuid4(),
        )


def test_self_dealing_is_rejected(customer: User):
    profile = Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=customer, profile_visibility="link_and_deals"
    )
    with pytest.raises(services.SelfDealingError):
        services.create_draft(
            user=customer,
            my_role=_ROLE.CUSTOMER,
            contract_type_code="loan_individuals",
            counterparty_profile_id=profile.id,
        )


def test_business_acting_as_without_entity_id_is_rejected(customer: User, contractor: User):
    contractor_profile = Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=contractor, profile_visibility="link_and_deals"
    )
    with pytest.raises(services.EntityNotControlledError):
        services.create_draft(
            user=customer,
            my_role=_ROLE.CUSTOMER,
            my_acting_as=_ACTING_AS.BUSINESS,
            contract_type_code="services_business",
            counterparty_profile_id=contractor_profile.id,
        )


def test_business_acting_as_with_uncontrolled_entity_is_rejected(customer: User, contractor: User):
    """Юрлицо существует, но НЕ подтверждено вызывающим пользователем
    (claim_status=unclaimed) — представительство/создание карточки не даёт
    права заключать от его имени договоры (CLAUDE.md)."""
    entity = BusinessEntity.objects.create(
        country_of_registration="RU",
        local_form_code="ru_ooo",
        name="ООО Чужое",
        created_by=customer,
    )
    contractor_profile = Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=contractor, profile_visibility="link_and_deals"
    )
    with pytest.raises(services.EntityNotControlledError):
        services.create_draft(
            user=customer,
            my_role=_ROLE.CUSTOMER,
            my_acting_as=_ACTING_AS.BUSINESS,
            my_entity_id=entity.id,
            contract_type_code="services_business",
            counterparty_profile_id=contractor_profile.id,
        )


# --- source_contract_id: «как в прошлый раз» --------------------------------


def test_source_contract_id_copies_type_and_counterparty(customer: User, contractor: User):
    contractor_profile = Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=contractor, profile_visibility="link_and_deals"
    )
    first = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        contract_type_code="loan_individuals",
        counterparty_profile_id=contractor_profile.id,
        payment_method=Contract.PaymentMethod.CASH,
        title="Заём на инструмент",
    )
    second = services.create_draft(
        user=customer, my_role=_ROLE.CUSTOMER, source_contract_id=first.id
    )
    assert second.id != first.id
    assert second.contract_type_id == first.contract_type_id
    assert second.payment_method == first.payment_method
    assert {p.profile_id for p in second.parties.all()} == {
        p.profile_id for p in first.parties.all()
    }


def test_source_contract_id_inaccessible_to_non_party(customer: User, contractor: User):
    contractor_profile = Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=contractor, profile_visibility="link_and_deals"
    )
    first = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        contract_type_code="loan_individuals",
        counterparty_profile_id=contractor_profile.id,
    )
    stranger = _user("0011")
    with pytest.raises(services.SourceContractNotAccessibleError):
        services.create_draft(user=stranger, my_role=_ROLE.CUSTOMER, source_contract_id=first.id)


# --- PATCH: пересчёт segment/deal_type при смене типа или сторон -----------


def test_patch_draft_type_change_recomputes_segment(customer: User, contractor: User):
    contractor_profile = Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=contractor, profile_visibility="link_and_deals"
    )
    contract = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        client_option="service",
        counterparty_profile_id=contractor_profile.id,
    )
    assert contract.segment == "free_c2c"

    accounts_services.set_business_status(contractor, True)
    contract = services.patch_draft(contract, user=customer, client_option="service")
    assert contract.contract_type_id == "services_business"
    assert contract.segment == "paid_business"


def test_patch_draft_counterparty_change_recomputes_segment(customer: User, contractor: User):
    contractor_profile = Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=contractor, profile_visibility="link_and_deals"
    )
    contract = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        client_option="service",
        counterparty_profile_id=contractor_profile.id,
    )
    assert contract.segment == "free_c2c"

    other_contractor = _user("0012")
    entity = BusinessEntity.objects.create(
        country_of_registration="RU",
        local_form_code="ru_ooo",
        name="ООО Другой подрядчик",
        created_by=other_contractor,
        claim_status=BusinessEntity.ClaimStatus.CLAIMED,
        claimed_by=other_contractor,
    )
    business_profile = profiles_services.get_or_create_business_profile(entity)

    contract = services.patch_draft(
        contract,
        user=customer,
        client_option="service",
        counterparty_profile_id=business_profile.id,
    )
    assert contract.contract_type_id == "services_business"
    assert contract.segment == "paid_business"
    assert contract.deal_type == Contract.DealType.B2C


def test_patch_draft_after_send_is_rejected(customer: User, contractor: User):
    contractor_profile = Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=contractor, profile_visibility="link_and_deals"
    )
    contract = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        contract_type_code="loan_individuals",
        counterparty_profile_id=contractor_profile.id,
    )
    contract.negotiation_status = Contract.NegotiationStatus.UNDER_REVIEW
    contract.save(update_fields=["negotiation_status"])
    with pytest.raises(services.DraftNotEditableError):
        services.patch_draft(contract, user=customer, title="Новое название")


def test_patch_draft_by_non_party_is_rejected(customer: User, contractor: User):
    contractor_profile = Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=contractor, profile_visibility="link_and_deals"
    )
    contract = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        contract_type_code="loan_individuals",
        counterparty_profile_id=contractor_profile.id,
    )
    stranger = _user("0013")
    with pytest.raises(services.NotAPartyError):
        services.patch_draft(contract, user=stranger, title="Новое название")


def test_patch_draft_title_only_does_not_recompute_segment(customer: User, contractor: User):
    contractor_profile = Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=contractor, profile_visibility="link_and_deals"
    )
    contract = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        client_option="service",
        counterparty_profile_id=contractor_profile.id,
    )
    accounts_services.set_business_status(contractor, True)
    contract = services.patch_draft(contract, user=customer, title="Новое название")
    assert contract.title == "Новое название"
    assert contract.contract_type_id == "services_individual"
    assert contract.segment == "free_c2c"


# --- ADR-151: порядок оплаты (payment_order) -------------------------------


def _person_contractor_profile(contractor: User) -> Profile:
    return Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=contractor, profile_visibility="link_and_deals"
    )


def test_patch_draft_sets_payment_order(customer: User, contractor: User):
    contract = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        client_option="service",
        counterparty_profile_id=_person_contractor_profile(contractor).id,
    )
    assert contract.payment_order is None
    services.patch_draft(contract, user=customer, payment_order=Contract.PaymentOrder.BEFORE_START)
    contract.refresh_from_db()
    assert contract.payment_order == "before_start"


def test_create_draft_with_payment_order_on_loan_is_rejected(customer: User, contractor: User):
    """Займ: лист-этап — сам денежный транш, «до/после исполнения этапа» не
    определено — явный отказ вместо молчаливого сохранения (ADR-151)."""
    with pytest.raises(services.PaymentOrderNotApplicableError):
        services.create_draft(
            user=customer,
            my_role=_ROLE.CUSTOMER,
            contract_type_code="loan_individuals",
            counterparty_profile_id=_person_contractor_profile(contractor).id,
            payment_order=Contract.PaymentOrder.AFTER_ACCEPTANCE,
        )


def test_patch_draft_payment_order_on_loan_is_rejected(customer: User, contractor: User):
    contract = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        contract_type_code="loan_individuals",
        counterparty_profile_id=_person_contractor_profile(contractor).id,
    )
    with pytest.raises(services.PaymentOrderNotApplicableError):
        services.patch_draft(
            contract, user=customer, payment_order=Contract.PaymentOrder.AFTER_ACCEPTANCE
        )
    contract.refresh_from_db()
    assert contract.payment_order is None


def test_patch_draft_type_change_to_loan_clears_payment_order(customer: User, contractor: User):
    contract = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        client_option="service",
        counterparty_profile_id=_person_contractor_profile(contractor).id,
        payment_order=Contract.PaymentOrder.BEFORE_START,
    )
    contract = services.patch_draft(
        contract, user=customer, client_option="loan", contract_type_code="loan_individuals"
    )
    contract.refresh_from_db()
    assert contract.contract_type_id == "loan_individuals"
    assert contract.payment_order is None


def test_patch_draft_type_change_keeps_payment_order_when_applicable(
    customer: User, contractor: User
):
    contract = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        client_option="service",
        counterparty_profile_id=_person_contractor_profile(contractor).id,
        payment_order=Contract.PaymentOrder.BEFORE_START,
    )
    accounts_services.set_business_status(contractor, True)
    contract = services.patch_draft(contract, user=customer, client_option="service")
    contract.refresh_from_db()
    assert contract.contract_type_id == "services_business"
    assert contract.payment_order == "before_start"


def test_source_contract_id_copies_payment_order(customer: User, contractor: User):
    first = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        client_option="service",
        counterparty_profile_id=_person_contractor_profile(contractor).id,
        payment_method=Contract.PaymentMethod.CASH,
        payment_order=Contract.PaymentOrder.BEFORE_START,
    )
    second = services.create_draft(
        user=customer, my_role=_ROLE.CUSTOMER, source_contract_id=first.id
    )
    assert second.payment_order == "before_start"


def test_source_contract_id_drops_payment_order_for_loan(customer: User, contractor: User):
    """«Как в прошлый раз» с услуги на займ: порядок оплаты исходника к
    новому типу не относится — молча снимается, а не 400."""
    first = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        client_option="service",
        counterparty_profile_id=_person_contractor_profile(contractor).id,
        payment_order=Contract.PaymentOrder.BEFORE_START,
    )
    second = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        client_option="loan",
        contract_type_code="loan_individuals",
        source_contract_id=first.id,
    )
    assert second.contract_type_id == "loan_individuals"
    assert second.payment_order is None


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        ("services_individual", True),
        ("services_business", True),
        ("loan_individuals", False),
    ],
)
def test_payment_order_applicable_by_client_option(code: str, expected: bool):
    assert services.payment_order_applicable(code) is expected
