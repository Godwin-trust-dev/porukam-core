"""БД-инварианты apps.contracts — на живом PostgreSQL."""

from __future__ import annotations

import pytest
from django.db import IntegrityError, transaction

from apps.accounts.models import User
from apps.contracts.models import Contract, ContractParty, RevisionProposal
from apps.entities.models import BusinessEntity
from apps.profiles.models import Profile

pytestmark = pytest.mark.django_db


@pytest.fixture
def customer() -> User:
    return User.objects.create(trust_id="trust-contracts-model-customer", phone="+79990840001")


@pytest.fixture
def contractor() -> User:
    return User.objects.create(trust_id="trust-contracts-model-contractor", phone="+79990840002")


@pytest.fixture
def customer_profile(customer: User) -> Profile:
    return Profile.objects.create(
        kind=Profile.Kind.PERSON,
        owner_user=customer,
        profile_visibility=Profile.Visibility.LINK_AND_DEALS,
    )


@pytest.fixture
def contractor_profile(contractor: User) -> Profile:
    return Profile.objects.create(
        kind=Profile.Kind.PERSON,
        owner_user=contractor,
        profile_visibility=Profile.Visibility.LINK_AND_DEALS,
    )


@pytest.fixture
def entity(contractor: User) -> BusinessEntity:
    return BusinessEntity.objects.create(
        country_of_registration="RU",
        local_form_code="ru_ooo",
        name="ООО Ромашка",
        created_by=contractor,
    )


@pytest.fixture
def contract(customer: User) -> Contract:
    return Contract.objects.create(
        contract_type_id="services_individual",
        deal_type=Contract.DealType.C2C,
        segment="free_c2c",
        jurisdiction="RU",
        created_by=customer,
    )


def test_one_party_per_role(
    contract: Contract, customer_profile: Profile, contractor_profile: Profile
):
    ContractParty.objects.create(
        contract=contract,
        role=ContractParty.Role.CUSTOMER,
        profile=customer_profile,
        acting_as=ContractParty.ActingAs.PERSON,
    )
    with pytest.raises(IntegrityError), transaction.atomic():
        ContractParty.objects.create(
            contract=contract,
            role=ContractParty.Role.CUSTOMER,
            profile=contractor_profile,
            acting_as=ContractParty.ActingAs.PERSON,
        )


def test_role_must_be_customer_or_contractor(contract: Contract, customer_profile: Profile):
    with pytest.raises(IntegrityError), transaction.atomic():
        ContractParty.objects.create(
            contract=contract,
            role="bogus",
            profile=customer_profile,
            acting_as=ContractParty.ActingAs.PERSON,
        )


def test_acting_as_must_be_person_or_business(contract: Contract, customer_profile: Profile):
    with pytest.raises(IntegrityError), transaction.atomic():
        ContractParty.objects.create(
            contract=contract,
            role=ContractParty.Role.CUSTOMER,
            profile=customer_profile,
            acting_as="bogus",
        )


def test_entity_requires_business_acting_as(
    contract: Contract, customer_profile: Profile, entity: BusinessEntity
):
    with pytest.raises(IntegrityError), transaction.atomic():
        ContractParty.objects.create(
            contract=contract,
            role=ContractParty.Role.CUSTOMER,
            profile=customer_profile,
            entity=entity,
            acting_as=ContractParty.ActingAs.PERSON,
        )


def test_business_acting_as_with_entity_is_allowed(contract: Contract, entity: BusinessEntity):
    business_profile = Profile.objects.create(
        kind=Profile.Kind.BUSINESS,
        owner_entity=entity,
        profile_visibility=Profile.Visibility.PUBLIC,
    )
    party = ContractParty.objects.create(
        contract=contract,
        role=ContractParty.Role.CUSTOMER,
        profile=business_profile,
        entity=entity,
        acting_as=ContractParty.ActingAs.BUSINESS,
    )
    assert party.pk is not None


# --- Э4.2: RevisionProposal --------------------------------------------


def test_revision_proposal_status_must_be_valid(contract: Contract, customer_profile: Profile):
    with pytest.raises(IntegrityError), transaction.atomic():
        RevisionProposal.objects.create(
            contract=contract,
            item_ref="title",
            new_value="Ремонт крана 2",
            proposed_by=customer_profile,
            status="bogus",
        )


def test_revision_proposal_open_status_is_allowed(contract: Contract, customer_profile: Profile):
    proposal = RevisionProposal.objects.create(
        contract=contract,
        item_ref="title",
        new_value="Ремонт крана 2",
        proposed_by=customer_profile,
    )
    assert proposal.status == RevisionProposal.Status.OPEN
