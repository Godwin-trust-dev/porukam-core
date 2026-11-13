"""ADR-167: ручной ввод «Дополнительных условий» в мастере создания договора.

Тот же список `Contract.additional_terms`, что копит принятая правка «Другое»
(ADR-123), но редактируемый напрямую PATCH'ем черновика — и только пока
`negotiation_status = draft`. Каждый запрет — отдельным тестом (CLAUDE.md)."""

from __future__ import annotations

import pytest
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.contracts import services
from apps.contracts.models import Contract, ContractParty
from apps.profiles.models import Profile

from ._signing_helpers import add_leaf_milestone

pytestmark = pytest.mark.django_db

_ROLE = ContractParty.Role


def _user(suffix: str) -> User:
    return User.objects.create(trust_id=f"trust-addterms-{suffix}", phone=f"+7999086{suffix}")


@pytest.fixture
def customer() -> User:
    return _user("0001")


@pytest.fixture
def contractor() -> User:
    return _user("0002")


@pytest.fixture
def contractor_profile(contractor: User) -> Profile:
    return Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=contractor, profile_visibility="link_and_deals"
    )


@pytest.fixture
def draft(customer: User, contractor_profile: Profile) -> Contract:
    return services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        client_option="service",
        counterparty_profile_id=contractor_profile.id,
        payment_method=Contract.PaymentMethod.CASH,
        payment_order=Contract.PaymentOrder.AFTER_ACCEPTANCE,
        title="Ремонт крана",
    )


def _client_for(user: User) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


# --- services: нормализация значения ----------------------------------------


def test_patch_draft_sets_additional_terms(draft: Contract, customer: User):
    services.patch_draft(draft, user=customer, additional_terms=["Ключи под расписку"])
    draft.refresh_from_db()
    assert draft.additional_terms == ["Ключи под расписку"]


def test_patch_draft_trims_each_item(draft: Contract, customer: User):
    services.patch_draft(draft, user=customer, additional_terms=["  Уборка после работ \n"])
    draft.refresh_from_db()
    assert draft.additional_terms == ["Уборка после работ"]


def test_patch_draft_replaces_whole_list(draft: Contract, customer: User):
    """Мастер шлёт список целиком (как form_data) — иначе удалить пункт нечем."""
    services.patch_draft(draft, user=customer, additional_terms=["Первое", "Второе"])
    services.patch_draft(draft, user=customer, additional_terms=["Второе"])
    draft.refresh_from_db()
    assert draft.additional_terms == ["Второе"]


def test_patch_draft_can_clear_list(draft: Contract, customer: User):
    services.patch_draft(draft, user=customer, additional_terms=["Первое"])
    services.patch_draft(draft, user=customer, additional_terms=[])
    draft.refresh_from_db()
    assert draft.additional_terms == []


def test_patch_draft_without_field_keeps_list(draft: Contract, customer: User):
    services.patch_draft(draft, user=customer, additional_terms=["Первое"])
    services.patch_draft(draft, user=customer, title="Другое название")
    draft.refresh_from_db()
    assert draft.additional_terms == ["Первое"]


def test_create_draft_accepts_additional_terms(customer: User, contractor_profile: Profile):
    contract = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        client_option="service",
        counterparty_profile_id=contractor_profile.id,
        additional_terms=["  Условие  "],
    )
    contract.refresh_from_db()
    assert contract.additional_terms == ["Условие"]


def test_copy_from_source_contract_does_not_carry_terms(
    draft: Contract, customer: User, contractor_profile: Profile
):
    """«Как в прошлый раз» копирует тип/стороны/форму, но НЕ условия исходной
    сделки — они итог её протокола разногласий."""
    services.patch_draft(draft, user=customer, additional_terms=["Условие прошлой сделки"])
    copy = services.create_draft(user=customer, my_role=_ROLE.CUSTOMER, source_contract_id=draft.id)
    assert copy.additional_terms == []


# --- запреты ----------------------------------------------------------------


def test_blank_item_is_rejected(draft: Contract, customer: User):
    with pytest.raises(services.AdditionalTermsInvalidError) as excinfo:
        services.patch_draft(draft, user=customer, additional_terms=["Первое", "   "])
    assert excinfo.value.errors[0]["field"] == "additional_terms.1"
    assert excinfo.value.errors[0]["code"] == "required"
    draft.refresh_from_db()
    assert draft.additional_terms == []


def test_too_long_item_is_rejected(draft: Contract, customer: User):
    long_text = "я" * (services.ADDITIONAL_TERM_MAX_LENGTH + 1)
    with pytest.raises(services.AdditionalTermsInvalidError) as excinfo:
        services.patch_draft(draft, user=customer, additional_terms=[long_text])
    assert excinfo.value.errors[0]["code"] == "max_length"


def test_item_at_max_length_is_accepted(draft: Contract, customer: User):
    text = "я" * services.ADDITIONAL_TERM_MAX_LENGTH
    services.patch_draft(draft, user=customer, additional_terms=[text])
    draft.refresh_from_db()
    assert draft.additional_terms == [text]


def test_too_many_items_is_rejected(draft: Contract, customer: User):
    items = [f"Условие {i}" for i in range(services.ADDITIONAL_TERMS_MAX_ITEMS + 1)]
    with pytest.raises(services.AdditionalTermsInvalidError) as excinfo:
        services.patch_draft(draft, user=customer, additional_terms=items)
    assert excinfo.value.errors[0]["field"] == "additional_terms"
    assert excinfo.value.errors[0]["code"] == "max_items"


def test_max_items_is_accepted(draft: Contract, customer: User):
    items = [f"Условие {i}" for i in range(services.ADDITIONAL_TERMS_MAX_ITEMS)]
    services.patch_draft(draft, user=customer, additional_terms=items)
    draft.refresh_from_db()
    assert len(draft.additional_terms) == services.ADDITIONAL_TERMS_MAX_ITEMS


def test_non_list_value_is_rejected(draft: Contract, customer: User):
    with pytest.raises(services.AdditionalTermsInvalidError) as excinfo:
        services.patch_draft(draft, user=customer, additional_terms="Условие")  # type: ignore[arg-type]
    assert excinfo.value.errors[0]["code"] == "invalid"


def test_non_string_item_is_rejected(draft: Contract, customer: User):
    with pytest.raises(services.AdditionalTermsInvalidError) as excinfo:
        services.patch_draft(draft, user=customer, additional_terms=[42])  # type: ignore[list-item]
    assert excinfo.value.errors[0]["field"] == "additional_terms.0"
    assert excinfo.value.errors[0]["code"] == "invalid"


def test_patch_after_send_is_rejected(draft: Contract, customer: User):
    """После отправки контрагенту свободный PATCH закрыт — правки только
    через протокол разногласий (ADR-123)."""
    services.send_for_review(draft, user=customer)
    with pytest.raises(services.DraftNotEditableError):
        services.patch_draft(draft, user=customer, additional_terms=["Позднее условие"])


# --- сосуществование с правкой «Другое» (ADR-123) ---------------------------


def test_accepted_other_revision_appends_to_manual_terms(
    draft: Contract, customer: User, contractor: User
):
    """Принятая правка «Другое» ДОПИСЫВАЕТ в конец ручного списка, не
    перетирает его."""
    services.patch_draft(draft, user=customer, additional_terms=["Ручное первое", "Ручное второе"])
    contract = services.send_for_review(draft, user=customer)
    proposal = services.propose_revision(
        contract, user=customer, item_ref="other", new_value="Из протокола"
    )
    services.accept_revision(proposal, user=contractor)
    contract.refresh_from_db()
    assert contract.additional_terms == ["Ручное первое", "Ручное второе", "Из протокола"]


def test_manual_terms_land_in_freeze_snapshot(draft: Contract, customer: User):
    services.patch_draft(draft, user=customer, additional_terms=["Ключи под расписку"])
    contract = services.send_for_review(draft, user=customer)
    add_leaf_milestone(contract, user=customer)
    version = services.freeze_contract(contract, user=customer)
    assert version.snapshot["additional_terms"] == ["Ключи под расписку"]


# --- API --------------------------------------------------------------------


def test_api_patch_additional_terms_is_200(draft: Contract, customer: User):
    resp = _client_for(customer).patch(
        f"/v1/contracts/{draft.id}",
        {"additional_terms": ["Ключи под расписку", "Уборка после работ"]},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["additional_terms"] == ["Ключи под расписку", "Уборка после работ"]


def test_api_blank_item_is_400(draft: Contract, customer: User):
    resp = _client_for(customer).patch(
        f"/v1/contracts/{draft.id}", {"additional_terms": ["  "]}, format="json"
    )
    assert resp.status_code == 400, resp.content
    assert resp.data["code"] == "additional_terms_invalid"
    assert resp.data["context"]["errors"][0]["field"] == "additional_terms.0"


def test_api_too_long_item_is_400(draft: Contract, customer: User):
    resp = _client_for(customer).patch(
        f"/v1/contracts/{draft.id}",
        {"additional_terms": ["я" * (services.ADDITIONAL_TERM_MAX_LENGTH + 1)]},
        format="json",
    )
    assert resp.status_code == 400, resp.content
    assert resp.data["context"]["errors"][0]["code"] == "max_length"


def test_api_too_many_items_is_400(draft: Contract, customer: User):
    resp = _client_for(customer).patch(
        f"/v1/contracts/{draft.id}",
        {"additional_terms": [f"У{i}" for i in range(services.ADDITIONAL_TERMS_MAX_ITEMS + 1)]},
        format="json",
    )
    assert resp.status_code == 400, resp.content
    assert resp.data["context"]["errors"][0]["code"] == "max_items"


def test_api_patch_after_send_is_409(draft: Contract, customer: User):
    services.send_for_review(draft, user=customer)
    resp = _client_for(customer).patch(
        f"/v1/contracts/{draft.id}", {"additional_terms": ["Позднее"]}, format="json"
    )
    assert resp.status_code == 409, resp.content
    assert resp.data["code"] == "draft_not_editable"
