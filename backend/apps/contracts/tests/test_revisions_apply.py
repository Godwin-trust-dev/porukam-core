"""ADR-123: правки v2 — `item_ref` по полям формы (`form.<key>`), `title`,
`other`; «Было» из договора; принятая правка ПРИМЕНЯЕТСЯ к договору;
«Другое» -> `Contract.additional_terms`; протокол разногласий и
дополнительные условия — в canonical snapshot заморозки. Каждый запрет —
отдельным тестом (CLAUDE.md)."""

from __future__ import annotations

import pytest
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.contracts import services
from apps.contracts.models import Contract, ContractParty, RevisionProposal
from apps.profiles.models import Profile
from common.fsm import InvalidTransitionError

from ._signing_helpers import add_leaf_milestone, make_signed_contract

pytestmark = pytest.mark.django_db

_ROLE = ContractParty.Role
_STATUS = RevisionProposal.Status

_SERVICE_FORM = {
    "sphere_code": "renovation",
    "work_description": "Поклейка обоев в гостиной",
    "location_type": "remote",
    "term_type": "relative_to_gate",
    "duration_days": 14,
    "price_type": "fixed",
}


def _user(suffix: str) -> User:
    return User.objects.create(trust_id=f"trust-revapply-{suffix}", phone=f"+7999088{suffix}")


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
def contract(customer: User, contractor_profile: Profile) -> Contract:
    """under_review «Услуга» с заполненной формой — есть что менять."""
    draft = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        client_option="service",
        counterparty_profile_id=contractor_profile.id,
        payment_method=Contract.PaymentMethod.CASH,
        payment_order=Contract.PaymentOrder.AFTER_ACCEPTANCE,
        title="Ремонт крана",
    )
    services.patch_draft(draft, user=customer, form_data=dict(_SERVICE_FORM))
    return services.send_for_review(draft, user=customer)


# --- propose: грамматика item_ref и «Было» ----------------------------------


def test_propose_form_field_fills_old_value_from_form_data(contract: Contract, customer: User):
    proposal = services.propose_revision(
        contract, user=customer, item_ref="form.duration_days", new_value="21"
    )
    assert proposal.old_value == 14
    assert proposal.new_value == "21"
    assert proposal.status == _STATUS.OPEN


def test_propose_form_field_not_filled_yet_has_none_old_value(contract: Contract, customer: User):
    proposal = services.propose_revision(
        contract, user=customer, item_ref="form.location_address", new_value="Москва"
    )
    assert proposal.old_value is None


def test_propose_explicit_old_value_is_kept(contract: Contract, customer: User):
    proposal = services.propose_revision(
        contract, user=customer, item_ref="form.duration_days", new_value=21, old_value=13
    )
    assert proposal.old_value == 13


def test_propose_title_fills_old_value_from_contract(contract: Contract, customer: User):
    proposal = services.propose_revision(contract, user=customer, item_ref="title", new_value="Н")
    assert proposal.old_value == "Ремонт крана"


def test_propose_empty_title_is_rejected(contract: Contract, customer: User):
    with pytest.raises(services.RevisionValueInvalidError):
        services.propose_revision(contract, user=customer, item_ref="title", new_value="   ")
    assert not contract.revision_proposals.exists()


def test_propose_non_string_title_is_rejected(contract: Contract, customer: User):
    with pytest.raises(services.RevisionValueInvalidError):
        services.propose_revision(contract, user=customer, item_ref="title", new_value=42)
    assert not contract.revision_proposals.exists()


def test_propose_too_long_title_is_rejected(contract: Contract, customer: User):
    with pytest.raises(services.RevisionValueInvalidError) as excinfo:
        services.propose_revision(contract, user=customer, item_ref="title", new_value="я" * 301)
    assert excinfo.value.errors[0]["code"] == "max_length"


def test_propose_unknown_form_key_is_rejected(contract: Contract, customer: User):
    with pytest.raises(services.RevisionItemUnknownError):
        services.propose_revision(contract, user=customer, item_ref="form.no_such", new_value=1)
    assert not contract.revision_proposals.exists()


def test_propose_other_has_no_old_value(contract: Contract, customer: User):
    proposal = services.propose_revision(
        contract, user=customer, item_ref="other", new_value="Ключи передаются под расписку"
    )
    assert proposal.old_value is None


def test_propose_other_with_empty_text_is_rejected(contract: Contract, customer: User):
    with pytest.raises(services.RevisionValueInvalidError):
        services.propose_revision(contract, user=customer, item_ref="other", new_value="   ")


def test_propose_legacy_free_item_ref_is_still_accepted(contract: Contract, customer: User):
    proposal = services.propose_revision(
        contract,
        user=customer,
        item_ref="milestones[0].amount",
        new_value={"amount": "5000.00", "currency": "RUB"},
    )
    assert proposal.old_value is None
    assert proposal.status == _STATUS.OPEN


# --- accept: применение к договору ------------------------------------------


def test_accept_applies_integer_field_from_string(
    contract: Contract, customer: User, contractor: User
):
    proposal = services.propose_revision(
        contract, user=customer, item_ref="form.duration_days", new_value="21"
    )
    services.accept_revision(proposal, user=contractor)
    contract.refresh_from_db()
    assert contract.form_data["duration_days"] == 21
    # остальные поля формы не тронуты, дефолты сохранены
    assert contract.form_data["work_description"] == _SERVICE_FORM["work_description"]
    assert contract.form_data["warranty_period_days"] == 14


def test_accept_applies_choice_field(contract: Contract, customer: User, contractor: User):
    proposal = services.propose_revision(
        contract, user=customer, item_ref="form.price_type", new_value="estimate"
    )
    services.accept_revision(proposal, user=contractor)
    contract.refresh_from_db()
    assert contract.form_data["price_type"] == "estimate"


def test_accept_applies_boolean_field_from_string(
    contract: Contract, customer: User, contractor: User
):
    proposal = services.propose_revision(
        contract, user=customer, item_ref="form.access_required", new_value="true"
    )
    assert proposal.old_value is False
    services.accept_revision(proposal, user=contractor)
    contract.refresh_from_db()
    assert contract.form_data["access_required"] is True


def test_accept_applies_title(contract: Contract, customer: User, contractor: User):
    proposal = services.propose_revision(
        contract, user=customer, item_ref="title", new_value="Ремонт крана и труб"
    )
    services.accept_revision(proposal, user=contractor)
    contract.refresh_from_db()
    assert contract.title == "Ремонт крана и труб"


def test_accept_other_appends_additional_term(contract: Contract, customer: User, contractor: User):
    first = services.propose_revision(
        contract, user=customer, item_ref="other", new_value="Ключи под расписку"
    )
    second = services.propose_revision(
        contract, user=customer, item_ref="other", new_value="Уборка после работ"
    )
    services.accept_revision(first, user=contractor)
    services.accept_revision(second, user=contractor)
    contract.refresh_from_db()
    assert contract.additional_terms == ["Ключи под расписку", "Уборка после работ"]


def test_accept_invalid_choice_keeps_proposal_open_and_contract_untouched(
    contract: Contract, customer: User, contractor: User
):
    proposal = services.propose_revision(
        contract, user=customer, item_ref="form.price_type", new_value="hourly"
    )
    with pytest.raises(services.RevisionValueInvalidError) as excinfo:
        services.accept_revision(proposal, user=contractor)
    assert excinfo.value.errors[0]["field"] == "price_type"
    proposal.refresh_from_db()
    contract.refresh_from_db()
    assert proposal.status == _STATUS.OPEN
    assert proposal.decided_at is None
    assert contract.form_data["price_type"] == "fixed"


def test_accept_out_of_range_integer_is_invalid(
    contract: Contract, customer: User, contractor: User
):
    proposal = services.propose_revision(
        contract, user=customer, item_ref="form.duration_days", new_value="-3"
    )
    with pytest.raises(services.RevisionValueInvalidError):
        services.accept_revision(proposal, user=contractor)
    contract.refresh_from_db()
    assert contract.form_data["duration_days"] == 14


def test_accept_empty_title_is_invalid(contract: Contract, customer: User, contractor: User):
    """Гейт на применении — вторая линия обороны: пустое «Стало» не может
    просочиться в договор, даже если предложение оказалось в БД в обход
    propose (правка данных, старые записи)."""
    proposal = services.propose_revision(contract, user=customer, item_ref="title", new_value="Ок")
    RevisionProposal.objects.filter(id=proposal.id).update(new_value="   ")
    proposal.refresh_from_db()
    with pytest.raises(services.RevisionValueInvalidError):
        services.accept_revision(proposal, user=contractor)
    proposal.refresh_from_db()
    contract.refresh_from_db()
    assert proposal.status == _STATUS.OPEN
    assert contract.title == "Ремонт крана"


def test_accept_legacy_free_item_ref_applies_nothing(
    contract: Contract, customer: User, contractor: User
):
    proposal = services.propose_revision(
        contract, user=customer, item_ref="milestones[0].amount", new_value={"amount": "1"}
    )
    before = dict(contract.form_data)
    accepted = services.accept_revision(proposal, user=contractor)
    contract.refresh_from_db()
    assert accepted.status == _STATUS.ACCEPTED
    assert contract.form_data == before
    assert contract.title == "Ремонт крана"
    assert contract.additional_terms == []


def test_accepted_value_becomes_old_value_of_next_proposal(
    contract: Contract, customer: User, contractor: User
):
    """Требование отсмотра: «если правка принята, то в это поле должно
    попадать новое значение» — следующая правка по тому же полю видит
    применённое значение в «Было»."""
    first = services.propose_revision(
        contract, user=customer, item_ref="form.duration_days", new_value=21
    )
    services.accept_revision(first, user=contractor)
    contract.refresh_from_db()
    second = services.propose_revision(
        contract, user=customer, item_ref="form.duration_days", new_value=30
    )
    assert second.old_value == 21


def test_accepted_title_becomes_old_value_of_next_proposal(
    contract: Contract, customer: User, contractor: User
):
    first = services.propose_revision(contract, user=customer, item_ref="title", new_value="Второе")
    services.accept_revision(first, user=contractor)
    contract.refresh_from_db()
    second = services.propose_revision(
        contract, user=customer, item_ref="title", new_value="Третье"
    )
    assert second.old_value == "Второе"


def test_apply_alternative_with_null_value_returns_optional_field_to_default(
    contract: Contract, customer: User, contractor: User
):
    """`new_value` предложения NOT NULL (модель), поэтому «убрать своё
    значение» выражается только альтернативой `payload={"value": null}`:
    ключ вынимается из form_data, схема подставляет дефолт
    (warranty_period_days -> 14)."""
    raised = services.propose_revision(
        contract, user=customer, item_ref="form.warranty_period_days", new_value=90
    )
    services.accept_revision(raised, user=contractor)
    contract.refresh_from_db()
    assert contract.form_data["warranty_period_days"] == 90

    alternative = services.create_preapproved_alternative(
        contract, user=customer, item_ref="form.warranty_period_days", payload={"value": None}
    )
    services.apply_preapproved_alternative(alternative, user=contractor)
    contract.refresh_from_db()
    assert contract.form_data["warranty_period_days"] == 14


def test_apply_alternative_with_null_value_on_required_field_is_invalid(
    contract: Contract, customer: User, contractor: User
):
    alternative = services.create_preapproved_alternative(
        contract, user=customer, item_ref="form.work_description", payload={"value": None}
    )
    with pytest.raises(services.RevisionValueInvalidError) as excinfo:
        services.apply_preapproved_alternative(alternative, user=contractor)
    assert excinfo.value.errors[0]["code"] == "required"
    contract.refresh_from_db()
    assert contract.form_data["work_description"] == _SERVICE_FORM["work_description"]


def test_reject_does_not_apply(contract: Contract, customer: User, contractor: User):
    proposal = services.propose_revision(
        contract, user=customer, item_ref="form.duration_days", new_value=30
    )
    services.reject_revision(proposal, user=contractor)
    contract.refresh_from_db()
    assert contract.form_data["duration_days"] == 14


# --- counter / accept-all / preapproved -------------------------------------


def test_counter_then_accept_applies_counter_value(
    contract: Contract, customer: User, contractor: User
):
    original = services.propose_revision(
        contract, user=customer, item_ref="form.duration_days", new_value=21
    )
    counter = services.counter_revision(original, user=contractor, new_value="28")
    assert counter.old_value == 21
    services.accept_revision(counter, user=customer)
    contract.refresh_from_db()
    assert contract.form_data["duration_days"] == 28


def test_counter_other_with_empty_text_is_rejected(
    contract: Contract, customer: User, contractor: User
):
    original = services.propose_revision(contract, user=customer, item_ref="other", new_value="А")
    with pytest.raises(services.RevisionValueInvalidError):
        services.counter_revision(original, user=contractor, new_value="")
    original.refresh_from_db()
    assert original.status == _STATUS.OPEN


def test_accept_all_applies_every_open_proposal(
    contract: Contract, customer: User, contractor: User
):
    services.propose_revision(contract, user=contractor, item_ref="title", new_value="Новое")
    services.propose_revision(
        contract, user=contractor, item_ref="form.price_type", new_value="estimate"
    )
    services.propose_revision(contract, user=contractor, item_ref="other", new_value="Условие")
    accepted = services.accept_all_revisions(contract, user=customer)
    assert len(accepted) == 3
    contract.refresh_from_db()
    assert contract.title == "Новое"
    assert contract.form_data["price_type"] == "estimate"
    assert contract.additional_terms == ["Условие"]


def test_accept_all_with_one_invalid_value_rolls_back_everything(
    contract: Contract, customer: User, contractor: User
):
    services.propose_revision(contract, user=contractor, item_ref="title", new_value="Новое")
    services.propose_revision(
        contract, user=contractor, item_ref="form.price_type", new_value="hourly"
    )
    with pytest.raises(services.RevisionValueInvalidError):
        services.accept_all_revisions(contract, user=customer)
    contract.refresh_from_db()
    assert contract.title == "Ремонт крана"
    assert contract.form_data["price_type"] == "fixed"
    assert all(p.status == _STATUS.OPEN for p in contract.revision_proposals.all())


def test_apply_preapproved_alternative_applies_title(
    contract: Contract, customer: User, contractor: User
):
    alternative = services.create_preapproved_alternative(
        contract, user=customer, item_ref="title", payload={"title": "Из альтернативы"}
    )
    services.apply_preapproved_alternative(alternative, user=contractor)
    contract.refresh_from_db()
    assert contract.title == "Из альтернативы"


def test_apply_preapproved_alternative_with_value_key_applies_form_field(
    contract: Contract, customer: User, contractor: User
):
    alternative = services.create_preapproved_alternative(
        contract, user=customer, item_ref="form.duration_days", payload={"value": 7}
    )
    services.apply_preapproved_alternative(alternative, user=contractor)
    contract.refresh_from_db()
    assert contract.form_data["duration_days"] == 7


def test_apply_preapproved_alternative_other_appends_additional_term(
    contract: Contract, customer: User, contractor: User
):
    alternative = services.create_preapproved_alternative(
        contract, user=customer, item_ref="other", payload={"text": "Материалы заказчика"}
    )
    services.apply_preapproved_alternative(alternative, user=contractor)
    contract.refresh_from_db()
    assert contract.additional_terms == ["Материалы заказчика"]


def test_apply_preapproved_alternative_fills_old_value_from_contract(
    contract: Contract, customer: User, contractor: User
):
    """Нет вытесняемого предложения — «Было» берётся из договора (ADR-123),
    а не остаётся None."""
    alternative = services.create_preapproved_alternative(
        contract, user=customer, item_ref="form.duration_days", payload={"value": 7}
    )
    applied = services.apply_preapproved_alternative(alternative, user=contractor)
    assert applied.old_value == 14


def test_create_preapproved_alternative_with_unknown_form_key_is_rejected(
    contract: Contract, customer: User
):
    with pytest.raises(services.RevisionItemUnknownError):
        services.create_preapproved_alternative(
            contract, user=customer, item_ref="form.no_such", payload={"value": 1}
        )
    assert not contract.preapproved_alternatives.exists()


def test_create_preapproved_alternative_without_value_is_rejected(
    contract: Contract, customer: User
):
    """Адресуемый item_ref без значения в payload нельзя «одобрить заранее»:
    применить такую альтернативу было бы нечем."""
    with pytest.raises(services.RevisionValueInvalidError):
        services.create_preapproved_alternative(
            contract, user=customer, item_ref="title", payload={"note": "потом придумаем"}
        )
    assert not contract.preapproved_alternatives.exists()


def test_create_preapproved_alternative_with_empty_other_text_is_rejected(
    contract: Contract, customer: User
):
    with pytest.raises(services.RevisionValueInvalidError):
        services.create_preapproved_alternative(
            contract, user=customer, item_ref="other", payload={"text": "  "}
        )


def test_create_preapproved_alternative_with_free_item_ref_is_still_allowed(
    contract: Contract, customer: User, contractor: User
):
    alternative = services.create_preapproved_alternative(
        contract, user=customer, item_ref="payment_method", payload={"payment_method": "external"}
    )
    services.apply_preapproved_alternative(alternative, user=contractor)
    contract.refresh_from_db()
    assert contract.additional_terms == []
    assert contract.title == "Ремонт крана"


# --- заморозка: snapshot несёт дополнительные условия и протокол ------------


def test_snapshot_contains_additional_terms_and_revisions(
    contract: Contract, customer: User, contractor: User
):
    accepted = services.propose_revision(
        contract, user=customer, item_ref="other", new_value="Ключи под расписку"
    )
    services.accept_revision(accepted, user=contractor)
    rejected = services.propose_revision(
        contract, user=customer, item_ref="form.duration_days", new_value=99
    )
    services.reject_revision(rejected, user=contractor)
    add_leaf_milestone(contract, user=customer)

    version = services.freeze_contract(contract, user=customer)

    assert version.snapshot["additional_terms"] == ["Ключи под расписку"]
    revisions = version.snapshot["revisions"]
    assert [r["id"] for r in revisions] == [str(accepted.id), str(rejected.id)]
    assert revisions[0]["status"] == "accepted"
    assert revisions[0]["item_ref"] == "other"
    assert revisions[0]["new_value"] == "Ключи под расписку"
    assert revisions[1]["status"] == "rejected"
    assert revisions[1]["old_value"] == 14
    assert revisions[1]["proposed_by_profile_id"] == str(
        services.get_party_for_user(contract, customer).profile_id
    )
    assert revisions[1]["decided_at"] is not None
    assert version.snapshot["form_data"]["duration_days"] == 14


def test_snapshot_without_revisions_has_empty_protocol(contract: Contract, customer: User):
    add_leaf_milestone(contract, user=customer)
    version = services.freeze_contract(contract, user=customer)
    assert version.snapshot["revisions"] == []
    assert version.snapshot["additional_terms"] == []


def test_accept_after_freeze_is_invalid_transition(
    contract: Contract, customer: User, contractor: User
):
    proposal = services.propose_revision(
        contract, user=customer, item_ref="form.duration_days", new_value=21
    )
    services.reject_revision(proposal, user=contractor)
    add_leaf_milestone(contract, user=customer)
    services.freeze_contract(contract, user=customer)
    contract.refresh_from_db()
    # Отклонённое предложение уже не open — но гейт FSM срабатывает раньше:
    # после заморозки протокол разногласий закрыт целиком.
    proposal.refresh_from_db()
    proposal.status = _STATUS.OPEN
    proposal.save(update_fields=["status"])
    with pytest.raises(InvalidTransitionError):
        services.accept_revision(proposal, user=contractor)
    contract.refresh_from_db()
    assert contract.form_data["duration_days"] == 14


def test_counter_after_freeze_is_invalid_transition(
    contract: Contract, customer: User, contractor: User
):
    proposal = services.propose_revision(contract, user=customer, item_ref="title", new_value="А")
    services.reject_revision(proposal, user=contractor)
    add_leaf_milestone(contract, user=customer)
    services.freeze_contract(contract, user=customer)
    contract.refresh_from_db()
    RevisionProposal.objects.filter(id=proposal.id).update(status=_STATUS.OPEN)
    proposal.refresh_from_db()
    with pytest.raises(InvalidTransitionError):
        services.counter_revision(proposal, user=contractor, new_value="Б")
    contract.refresh_from_db()
    assert contract.title == "Ремонт крана"


def test_accept_all_after_freeze_is_invalid_transition(
    contract: Contract, customer: User, contractor: User
):
    proposal = services.propose_revision(contract, user=contractor, item_ref="title", new_value="А")
    services.reject_revision(proposal, user=customer)
    add_leaf_milestone(contract, user=customer)
    services.freeze_contract(contract, user=customer)
    contract.refresh_from_db()
    RevisionProposal.objects.filter(id=proposal.id).update(status=_STATUS.OPEN)
    with pytest.raises(InvalidTransitionError):
        services.accept_all_revisions(contract, user=customer)
    contract.refresh_from_db()
    assert contract.title == "Ремонт крана"


def test_apply_preapproved_alternative_after_freeze_is_invalid_transition(
    contract: Contract, customer: User, contractor: User
):
    alternative = services.create_preapproved_alternative(
        contract, user=customer, item_ref="other", payload={"text": "Поздно"}
    )
    add_leaf_milestone(contract, user=customer)
    services.freeze_contract(contract, user=customer)
    contract.refresh_from_db()
    with pytest.raises(InvalidTransitionError):
        services.apply_preapproved_alternative(alternative, user=contractor)
    contract.refresh_from_db()
    assert contract.additional_terms == []


def test_propose_after_freeze_is_invalid_transition(contract: Contract, customer: User):
    add_leaf_milestone(contract, user=customer)
    services.freeze_contract(contract, user=customer)
    contract.refresh_from_db()
    with pytest.raises(InvalidTransitionError):
        services.propose_revision(contract, user=customer, item_ref="other", new_value="Поздно")


def test_signed_contract_is_untouched_by_revisions():
    customer, contractor = _user("0101"), _user("0102")
    signed = make_signed_contract(customer=customer, contractor=contractor)
    with pytest.raises(InvalidTransitionError):
        services.propose_revision(signed, user=customer, item_ref="title", new_value="Иначе")
    signed.refresh_from_db()
    assert signed.title == "Ремонт крана"
    assert signed.additional_terms == []
    assert signed.frozen_version is not None
    assert signed.frozen_version.snapshot["title"] == "Ремонт крана"


# --- API: коды ошибок и additional_terms в карточке -------------------------


def _client_for(user: User) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def test_api_unknown_form_key_is_422_revision_item_unknown(contract: Contract, customer: User):
    resp = _client_for(customer).post(
        f"/v1/contracts/{contract.id}/revisions",
        {"item_ref": "form.no_such", "new_value": 1},
        format="json",
    )
    assert resp.status_code == 422, resp.content
    assert resp.data["code"] == "revision_item_unknown"


def test_api_invalid_value_on_accept_is_422_revision_value_invalid(
    contract: Contract, customer: User, contractor: User
):
    proposal = services.propose_revision(
        contract, user=customer, item_ref="form.price_type", new_value="hourly"
    )
    resp = _client_for(contractor).post(f"/v1/revisions/{proposal.id}/accept", format="json")
    assert resp.status_code == 422, resp.content
    assert resp.data["code"] == "revision_value_invalid"
    assert resp.data["context"]["errors"][0]["field"] == "price_type"


def test_api_accept_all_invalid_value_is_422(contract: Contract, customer: User, contractor: User):
    services.propose_revision(contract, user=contractor, item_ref="form.price_type", new_value="x")
    resp = _client_for(customer).post(
        f"/v1/contracts/{contract.id}/revisions/accept-all", {}, format="json"
    )
    assert resp.status_code == 422, resp.content
    assert resp.data["code"] == "revision_value_invalid"


def test_api_empty_other_text_is_422_revision_value_invalid(contract: Contract, customer: User):
    resp = _client_for(customer).post(
        f"/v1/contracts/{contract.id}/revisions",
        {"item_ref": "other", "new_value": "   "},
        format="json",
    )
    assert resp.status_code == 422, resp.content
    assert resp.data["code"] == "revision_value_invalid"
    assert resp.data["context"]["errors"][0]["field"] == "other"


def test_api_preapproved_alternative_unknown_form_key_is_422(contract: Contract, customer: User):
    resp = _client_for(customer).post(
        f"/v1/contracts/{contract.id}/preapproved-alternatives",
        {"item_ref": "form.no_such", "payload": {"value": 1}},
        format="json",
    )
    assert resp.status_code == 422, resp.content
    assert resp.data["code"] == "revision_item_unknown"


def test_api_contract_detail_exposes_additional_terms(
    contract: Contract, customer: User, contractor: User
):
    proposal = services.propose_revision(
        contract, user=customer, item_ref="other", new_value="Условие"
    )
    services.accept_revision(proposal, user=contractor)
    resp = _client_for(customer).get(f"/v1/contracts/{contract.id}")
    assert resp.status_code == 200, resp.content
    assert resp.data["additional_terms"] == ["Условие"]
