"""apps.contracts — ADR-161: черновик допника редактируем и удаляем ДО
отправки. Каждый запрет — отдельным тестом (CLAUDE.md): не инициатор → 403
`not_initiator`, не draft → 409 `amendment_not_draft`, чужой черновик не
виден в списке и по прямому id. Сервисный слой и API — отдельными блоками,
тот же приём, что test_amendments.py / test_amendments_api.py."""

from __future__ import annotations

import uuid
from decimal import Decimal

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.contracts import selectors, services
from apps.contracts.models import Amendment, AmendmentChange, Contract, ContractParty
from apps.milestones.models import Milestone

from ._signing_helpers import make_signed_contract, make_user

pytestmark = pytest.mark.django_db

_ROLE = ContractParty.Role
_STATUS = Contract.NegotiationStatus
_CHANGE_TYPE = AmendmentChange.Type


def _client(user: User) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def customer() -> User:
    return make_user("d0001")


@pytest.fixture
def contractor() -> User:
    return make_user("d0002")


@pytest.fixture
def signed_contract(customer: User, contractor: User) -> Contract:
    return make_signed_contract(customer=customer, contractor=contractor)


@pytest.fixture
def milestone(signed_contract: Contract) -> Milestone:
    return signed_contract.milestones.get()


@pytest.fixture
def draft(signed_contract: Contract, customer: User) -> Amendment:
    return services.create_amendment(
        signed_contract,
        user=customer,
        reason="Первая редакция",
        custom_terms="Условие A",
        changes=[
            {
                "type": _CHANGE_TYPE.ADD_MILESTONE,
                "payload": {"title": "Доп. работа", "amount": "3000.00", "currency": "RUB"},
            }
        ],
    )


# --- update_draft_amendment --------------------------------------------------


def test_update_draft_replaces_reason_and_custom_terms(draft: Amendment, customer: User):
    services.update_draft_amendment(
        draft,
        user=customer,
        reason="Вторая редакция",
        custom_terms="Условие B",
        changes=[],
    )
    draft.refresh_from_db()
    assert draft.reason == "Вторая редакция"
    assert draft.custom_terms == "Условие B"
    assert draft.negotiation_status == _STATUS.DRAFT


def test_update_draft_replaces_changes_wholesale(draft: Amendment, customer: User):
    """`changes` заменяется ЦЕЛИКОМ: прежний ADD_MILESTONE исчезает, а не
    дополняется вторым."""
    old_change_id = draft.changes.get().id
    services.update_draft_amendment(
        draft,
        user=customer,
        reason="Вторая редакция",
        changes=[
            {
                "type": _CHANGE_TYPE.ADD_MILESTONE,
                "payload": {"title": "Другая работа", "amount": "1000.00", "currency": "RUB"},
            }
        ],
    )
    change = draft.changes.get()
    assert change.id != old_change_id
    assert change.payload["title"] == "Другая работа"


def test_update_draft_recomputes_deltas(draft: Amendment, customer: User, milestone: Milestone):
    """Дельты пересчитываются сервером от текущего дерева — тем же
    `_create_amendment_change`, что при создании."""
    before, _days = services.compute_amendment_deltas(draft)
    assert before is not None and before.amount == Decimal("3000.00")

    services.update_draft_amendment(
        draft,
        user=customer,
        reason="Подешевле",
        changes=[
            {
                "type": _CHANGE_TYPE.MODIFY_MILESTONE,
                "target": milestone.id,
                "payload": {"amount": "12000.00", "currency": "RUB"},
            }
        ],
    )
    total, days = services.compute_amendment_deltas(draft)
    assert total is not None
    # лист стоил 10000.00 (_signing_helpers.add_leaf_milestone) -> +2000.00
    assert total.amount == Decimal("2000.00")
    assert total.currency == "RUB"
    assert days == 0


def test_update_draft_to_empty_changes_is_allowed(draft: Amendment, customer: User):
    services.update_draft_amendment(draft, user=customer, reason="Только текст", changes=[])
    assert draft.changes.count() == 0


def test_update_draft_by_counterparty_is_not_initiator(draft: Amendment, contractor: User):
    with pytest.raises(services.NotInitiatorError):
        services.update_draft_amendment(draft, user=contractor, reason="Моя правка", changes=[])


def test_update_draft_by_stranger_is_not_a_party(draft: Amendment):
    stranger = make_user("d0003")
    with pytest.raises(services.NotAPartyError):
        services.update_draft_amendment(draft, user=stranger, reason="x", changes=[])


def test_update_after_send_is_not_draft(draft: Amendment, customer: User):
    services.send_amendment_for_review(draft, user=customer)
    with pytest.raises(services.AmendmentNotDraftError):
        services.update_draft_amendment(draft, user=customer, reason="Поздно", changes=[])


def test_update_draft_with_bad_change_keeps_previous_changes(
    draft: Amendment, customer: User, milestone: Milestone
):
    """Гейты `_create_amendment_change` работают и на PATCH, и общая
    транзакция откатывает удаление прежнего списка."""
    milestone.accepted_at = timezone.now()
    milestone.save(update_fields=["accepted_at"])
    with pytest.raises(services.AmendmentTargetsAcceptedMilestoneError):
        services.update_draft_amendment(
            draft,
            user=customer,
            reason="Убрать принятое",
            changes=[{"type": _CHANGE_TYPE.REMOVE_MILESTONE, "target": milestone.id}],
        )
    draft.refresh_from_db()
    assert draft.reason == "Первая редакция"
    assert draft.changes.count() == 1


def test_update_draft_with_unknown_target_is_404_error(draft: Amendment, customer: User):
    with pytest.raises(services.AmendmentChangeTargetNotFoundError):
        services.update_draft_amendment(
            draft,
            user=customer,
            reason="x",
            changes=[{"type": _CHANGE_TYPE.REMOVE_MILESTONE, "target": uuid.uuid4()}],
        )


# --- delete_draft_amendment --------------------------------------------------


def test_delete_draft_removes_amendment_and_its_changes(draft: Amendment, customer: User):
    amendment_id = draft.id
    services.delete_draft_amendment(draft, user=customer)
    assert not Amendment.objects.filter(pk=amendment_id).exists()
    assert not AmendmentChange.objects.filter(amendment_id=amendment_id).exists()


def test_delete_draft_frees_its_order(signed_contract: Contract, draft: Amendment, customer: User):
    """Номер выброшенной заготовки переиспользуется — сквозная нумерация
    допников договора не зияет дырами."""
    assert draft.order == 1
    services.delete_draft_amendment(draft, user=customer)
    again = services.create_amendment(signed_contract, user=customer, reason="Заново", changes=[])
    assert again.order == 1


def test_delete_draft_by_counterparty_is_not_initiator(draft: Amendment, contractor: User):
    with pytest.raises(services.NotInitiatorError):
        services.delete_draft_amendment(draft, user=contractor)


def test_delete_draft_by_stranger_is_not_a_party(draft: Amendment):
    stranger = make_user("d0004")
    with pytest.raises(services.NotAPartyError):
        services.delete_draft_amendment(draft, user=stranger)


def test_delete_after_send_is_not_draft(draft: Amendment, customer: User):
    services.send_amendment_for_review(draft, user=customer)
    with pytest.raises(services.AmendmentNotDraftError):
        services.delete_draft_amendment(draft, user=customer)
    assert Amendment.objects.filter(pk=draft.id).exists()


def test_delete_withdrawn_amendment_is_not_draft(draft: Amendment, customer: User):
    """Терминальный статус — тоже «не черновик»: закрытый допник остаётся
    в истории договора."""
    services.send_amendment_for_review(draft, user=customer)
    services.withdraw_amendment(draft, user=customer)
    with pytest.raises(services.AmendmentNotDraftError):
        services.delete_draft_amendment(draft, user=customer)


# --- видимость чужого черновика ---------------------------------------------


def test_own_draft_is_visible_to_its_initiator(
    signed_contract: Contract, draft: Amendment, customer: User
):
    assert list(selectors.list_amendments(signed_contract, viewer=customer)) == [draft]
    assert selectors.is_amendment_visible_to(draft, customer) is True


def test_foreign_draft_is_hidden_from_counterparty(
    signed_contract: Contract, draft: Amendment, contractor: User
):
    assert list(selectors.list_amendments(signed_contract, viewer=contractor)) == []
    assert selectors.is_amendment_visible_to(draft, contractor) is False


def test_sent_amendment_becomes_visible_to_counterparty(
    signed_contract: Contract, draft: Amendment, customer: User, contractor: User
):
    services.send_amendment_for_review(draft, user=customer)
    assert list(selectors.list_amendments(signed_contract, viewer=contractor)) == [draft]
    assert selectors.is_amendment_visible_to(draft, contractor) is True


def test_list_without_viewer_keeps_everything_for_archive(
    signed_contract: Contract, draft: Amendment
):
    """apps.archive зовёт `list_amendments` без `viewer` — снимок всего."""
    assert list(selectors.list_amendments(signed_contract)) == [draft]


# --- API: PATCH / DELETE /amendments/{id} ------------------------------------


def test_patch_api_by_initiator(draft: Amendment, customer: User, milestone: Milestone):
    resp = _client(customer).patch(
        f"/v1/amendments/{draft.id}",
        {
            "reason": "Вторая редакция",
            "custom_terms": "Условие B",
            "changes": [
                {
                    "type": _CHANGE_TYPE.MODIFY_MILESTONE,
                    "target": str(milestone.id),
                    "payload": {"amount": "12000.00", "currency": "RUB"},
                }
            ],
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert body["reason"] == "Вторая редакция"
    assert body["custom_terms"] == "Условие B"
    assert body["negotiation_status"] == "draft"
    assert len(body["changes"]) == 1
    assert body["amount_delta"] == {"amount": "2000.00", "currency": "RUB"}


def test_patch_api_by_counterparty_is_404_for_a_draft(draft: Amendment, contractor: User):
    """Чужой черновик для второй стороны не существует — 404 раньше, чем
    403: 403 подтвердил бы, что заготовка заведена."""
    resp = _client(contractor).patch(
        f"/v1/amendments/{draft.id}", {"reason": "x", "changes": []}, format="json"
    )
    assert resp.status_code == 404
    assert resp.json()["code"] == "not_found"


def test_patch_api_by_counterparty_after_send_is_403(
    draft: Amendment, customer: User, contractor: User
):
    services.send_amendment_for_review(draft, user=customer)
    resp = _client(contractor).patch(
        f"/v1/amendments/{draft.id}", {"reason": "x", "changes": []}, format="json"
    )
    assert resp.status_code == 403
    assert resp.json()["code"] == "not_initiator"


def test_patch_api_after_send_is_409(draft: Amendment, customer: User):
    services.send_amendment_for_review(draft, user=customer)
    resp = _client(customer).patch(
        f"/v1/amendments/{draft.id}", {"reason": "x", "changes": []}, format="json"
    )
    assert resp.status_code == 409
    assert resp.json()["code"] == "amendment_not_draft"


def test_patch_api_by_stranger_is_403(draft: Amendment):
    resp = _client(make_user("d0005")).patch(
        f"/v1/amendments/{draft.id}", {"reason": "x", "changes": []}, format="json"
    )
    assert resp.status_code == 403
    assert resp.json()["code"] == "permission_denied"


def test_patch_api_without_reason_is_400(draft: Amendment, customer: User):
    resp = _client(customer).patch(f"/v1/amendments/{draft.id}", {"changes": []}, format="json")
    assert resp.status_code == 400


def test_patch_api_accepted_target_is_422(draft: Amendment, customer: User, milestone: Milestone):
    milestone.accepted_at = timezone.now()
    milestone.save(update_fields=["accepted_at"])
    resp = _client(customer).patch(
        f"/v1/amendments/{draft.id}",
        {
            "reason": "x",
            "changes": [{"type": _CHANGE_TYPE.REMOVE_MILESTONE, "target": str(milestone.id)}],
        },
        format="json",
    )
    assert resp.status_code == 422
    assert resp.json()["code"] == "amendment_targets_accepted"


def test_delete_api_by_initiator_is_204(draft: Amendment, customer: User):
    resp = _client(customer).delete(f"/v1/amendments/{draft.id}")
    assert resp.status_code == 204, resp.content
    assert not Amendment.objects.filter(pk=draft.id).exists()


def test_delete_api_twice_is_404(draft: Amendment, customer: User):
    client = _client(customer)
    assert client.delete(f"/v1/amendments/{draft.id}").status_code == 204
    assert client.delete(f"/v1/amendments/{draft.id}").status_code == 404


def test_delete_api_after_send_is_409(draft: Amendment, customer: User):
    services.send_amendment_for_review(draft, user=customer)
    resp = _client(customer).delete(f"/v1/amendments/{draft.id}")
    assert resp.status_code == 409
    assert resp.json()["code"] == "amendment_not_draft"


def test_delete_api_by_counterparty_is_404_for_a_draft(draft: Amendment, contractor: User):
    resp = _client(contractor).delete(f"/v1/amendments/{draft.id}")
    assert resp.status_code == 404
    assert Amendment.objects.filter(pk=draft.id).exists()


def test_get_api_foreign_draft_is_404(draft: Amendment, contractor: User):
    assert _client(contractor).get(f"/v1/amendments/{draft.id}").status_code == 404


def test_list_api_hides_foreign_draft(
    signed_contract: Contract, draft: Amendment, contractor: User
):
    resp = _client(contractor).get(f"/v1/contracts/{signed_contract.id}/amendments")
    assert resp.status_code == 200, resp.content
    assert resp.json() == []


def test_list_api_shows_own_draft(signed_contract: Contract, draft: Amendment, customer: User):
    resp = _client(customer).get(f"/v1/contracts/{signed_contract.id}/amendments")
    assert resp.status_code == 200, resp.content
    assert [a["id"] for a in resp.json()] == [str(draft.id)]
