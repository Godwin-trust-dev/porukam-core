"""GET /v1/reputation/profiles/{id}/card — ГВ.4 приёмка: карточка обеих
сторон сквозного сценария показывает сделку с исходом; гостю на
link_and_deals-профиле — стартовая карточка, не полная; нет DELETE."""

from __future__ import annotations

import pytest
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from apps.contracts.models import ContractParty
from apps.milestones import services as milestones_services
from apps.milestones.tests._execution_helpers import make_signed_contract_with_leaf, make_user
from common import relay

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

_ROLE = ContractParty.Role


def _auth_headers(user, *, acting_profile_id=None) -> dict:
    access = str(RefreshToken.for_user(user).access_token)
    headers = {"HTTP_AUTHORIZATION": f"Bearer {access}"}
    if acting_profile_id is not None:
        headers["HTTP_X_ACTING_PROFILE"] = str(acting_profile_id)
    return headers


def _complete_deal():
    customer = make_user("api001")
    contractor = make_user("api002")
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    milestones_services.start_milestone(milestone, user=customer)
    milestone.refresh_from_db()
    milestones_services.submit_milestone(milestone, user=contractor)
    milestone.refresh_from_db()
    milestones_services.accept_milestone(milestone, user=customer)
    milestone.refresh_from_db()
    milestones_services.confirm_payment(milestone, user=customer, side=_ROLE.CUSTOMER)
    milestones_services.confirm_payment(milestone, user=contractor, side=_ROLE.CONTRACTOR)
    relay.deliver_due_events()
    customer_profile_id = contract.parties.get(role=_ROLE.CUSTOMER).profile_id
    contractor_profile_id = contract.parties.get(role=_ROLE.CONTRACTOR).profile_id
    return customer, contractor, customer_profile_id, contractor_profile_id


def test_confirmed_counterparty_sees_full_card_with_the_deal_and_outcome():
    customer, contractor, customer_profile_id, contractor_profile_id = _complete_deal()
    client = APIClient()
    resp = client.get(
        f"/v1/reputation/profiles/{customer_profile_id}/card",
        **_auth_headers(contractor, acting_profile_id=contractor_profile_id),
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["restricted"] is False
    assert resp.data["deals_count"] == 1
    assert resp.data["counterparties_count"] == 1
    assert len(resp.data["deals"]) == 1
    deal = resp.data["deals"][0]
    assert deal["outcome"] == "completed"
    assert deal["counterparty"]["profile_id"] == str(contractor_profile_id)
    assert deal["counterparty"]["role"] == "contractor"


def test_both_sides_see_the_completed_deal_on_their_own_card():
    customer, contractor, customer_profile_id, contractor_profile_id = _complete_deal()
    client = APIClient()

    customer_card = client.get(
        f"/v1/reputation/profiles/{customer_profile_id}/card",
        **_auth_headers(customer, acting_profile_id=customer_profile_id),
    )
    contractor_card = client.get(
        f"/v1/reputation/profiles/{contractor_profile_id}/card",
        **_auth_headers(contractor, acting_profile_id=contractor_profile_id),
    )
    assert customer_card.data["deals_count"] == 1
    assert contractor_card.data["deals_count"] == 1


def test_anonymous_guest_gets_starter_card_for_link_and_deals_profile():
    _customer, _contractor, customer_profile_id, _contractor_profile_id = _complete_deal()
    client = APIClient()
    resp = client.get(f"/v1/reputation/profiles/{customer_profile_id}/card")
    assert resp.status_code == 200, resp.content
    assert resp.data["restricted"] is True
    assert resp.data["deals_count"] is None
    assert resp.data["counterparties_count"] is None
    assert resp.data["deals"] == []
    # Стартовая карточка не прячет сам факт существования профиля/возраст
    # (тот же принцип честности, что EmptyDashboard, docs/tasks/
    # DEV-auth-onboarding.md §7) — только сделки и производные счётчики.
    assert "profile_age_days" in resp.data


def test_unauthenticated_acting_profile_header_cannot_spoof_counterparty_access():
    """AllowAny-вьюха: анонимный запрос НЕ может подставить чужой
    X-Acting-Profile и получить полную карточку — ActingProfileMiddleware
    проверяет владение, только если запрос нёс валидный JWT."""
    _customer, _contractor, customer_profile_id, contractor_profile_id = _complete_deal()
    client = APIClient()
    resp = client.get(
        f"/v1/reputation/profiles/{customer_profile_id}/card",
        HTTP_X_ACTING_PROFILE=str(contractor_profile_id),
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["restricted"] is True


def test_card_exposes_handle_for_direct_profile_id_link():
    """ADR-093: карточку открывают и по прямой ссылке `profile_id` (сторона
    договора на его карточке), не только по `/@handle` — публичный
    идентификатор должен приехать с самой карточкой."""
    from apps.social.models import Handle

    customer, _contractor, customer_profile_id, _ = _complete_deal()
    Handle.objects.create(user=customer, value="zakazchik1")

    client = APIClient()
    resp = client.get(f"/v1/reputation/profiles/{customer_profile_id}/card")
    assert resp.status_code == 200, resp.content
    assert resp.data["handle"] == "zakazchik1"


def test_card_handle_is_null_when_user_has_no_active_handle():
    """Честный `null`, а не пустая строка/выдуманный хендл — свежий аккаунт
    до шага «Профиль» хендла ещё не имеет."""
    _customer, _contractor, customer_profile_id, _ = _complete_deal()
    client = APIClient()
    resp = client.get(f"/v1/reputation/profiles/{customer_profile_id}/card")
    assert resp.status_code == 200, resp.content
    assert resp.data["handle"] is None


def test_unknown_profile_is_404():
    client = APIClient()
    resp = client.get("/v1/reputation/profiles/00000000-0000-0000-0000-000000000000/card")
    assert resp.status_code == 404


def test_card_shows_public_group_memberships_even_on_starter_card():
    """ADR-117 §7: блок «состоит в объединениях» — активные членства в
    ПУБЛИЧНЫХ объединениях; виден и гостю при restricted=True (членство в
    публичном объединении публично по построению, как handle). Закрытое
    объединение на карточку не попадает."""
    from apps.social import services as social_services

    customer, _contractor, customer_profile_id, _ = _complete_deal()
    leader = make_user("api777")
    public_group = social_services.create_group(
        leader, kind="guild", name="Гильдия IT", handle="it_guild", sphere_code="it"
    )
    private_group = social_services.create_group(
        leader,
        kind="clan",
        name="Закрытый клан",
        handle="secret_clan",
        sphere_code="it",
        is_public=False,
    )
    social_services.join_group(public_group, customer)
    social_services.join_group(private_group, customer)

    resp = APIClient().get(f"/v1/reputation/profiles/{customer_profile_id}/card")
    assert resp.status_code == 200, resp.content
    assert resp.data["restricted"] is True
    assert [g["name"] for g in resp.data["groups"]] == ["Гильдия IT"]
    assert resp.data["groups"][0]["handle"] == "@it_guild"
    assert resp.data["groups"][0]["kind"] == "guild"


def test_no_delete_endpoint_for_a_deal_or_the_card():
    _customer, _contractor, customer_profile_id, _contractor_profile_id = _complete_deal()
    client = APIClient()
    resp = client.delete(f"/v1/reputation/profiles/{customer_profile_id}/card")
    assert resp.status_code == 405


# --- ADR-163: агрегаты карточки и приватный /insights -------------------


def test_full_card_carries_role_and_sphere_aggregates():
    customer, contractor, customer_profile_id, contractor_profile_id = _complete_deal()
    client = APIClient()
    resp = client.get(
        f"/v1/reputation/profiles/{contractor_profile_id}/card",
        **_auth_headers(contractor, acting_profile_id=contractor_profile_id),
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["by_role"]["contractor"]["deals"] == 1
    assert resp.data["disputes_free"] == {"done": 1, "total": 1}
    assert resp.data["repeat_counterparties"] == {"count": 0, "total": 1}
    assert resp.data["last_deal_at"] is not None


def test_starter_card_hides_every_aggregate_not_just_the_deal_list():
    """Агрегаты производны от списка сделок — если бы они приезжали, любая
    цифра сливала бы скрытую историю (ADR-163 §4)."""
    _customer, _contractor, customer_profile_id, _ = _complete_deal()
    resp = APIClient().get(f"/v1/reputation/profiles/{customer_profile_id}/card")
    assert resp.status_code == 200, resp.content
    assert resp.data["by_role"] is None
    assert resp.data["by_sphere"] == []
    assert resp.data["disputes_free"] is None
    assert resp.data["repeat_counterparties"] is None
    assert resp.data["last_deal_at"] is None


def test_public_card_never_exposes_volume_or_protected_payment_share():
    """ADR-163 §4: сумма чужой сделки — коммерческая тайна стороны, а не
    факт её надёжности. Полная карточка тоже их не отдаёт."""
    _customer, contractor, _customer_profile_id, contractor_profile_id = _complete_deal()
    resp = APIClient().get(
        f"/v1/reputation/profiles/{contractor_profile_id}/card",
        **_auth_headers(contractor, acting_profile_id=contractor_profile_id),
    )
    assert resp.status_code == 200, resp.content
    body = str(resp.data)
    assert "volume" not in resp.data
    assert "total_amount" not in body
    assert "protected" not in body


def test_owner_sees_own_insights():
    _customer, contractor, _customer_profile_id, contractor_profile_id = _complete_deal()
    resp = APIClient().get(
        f"/v1/reputation/profiles/{contractor_profile_id}/insights",
        **_auth_headers(contractor, acting_profile_id=contractor_profile_id),
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["profile_id"] == str(contractor_profile_id)
    assert "volume" in resp.data["hidden"]
    assert "protected_payments" in resp.data["hidden"]


def test_counterparty_of_a_completed_deal_is_still_denied_insights():
    """ЗАПРЕТ: контрагент видит полную карточку (ADR-059), но НЕ разбор —
    у этого документа нет аудитории, кроме владельца."""
    customer, _contractor, customer_profile_id, contractor_profile_id = _complete_deal()
    resp = APIClient().get(
        f"/v1/reputation/profiles/{contractor_profile_id}/insights",
        **_auth_headers(customer, acting_profile_id=customer_profile_id),
    )
    assert resp.status_code == 403, resp.content


def test_anonymous_guest_is_denied_insights():
    """ЗАПРЕТ: в отличие от карточки, разбор не `AllowAny`."""
    _customer, _contractor, _customer_profile_id, contractor_profile_id = _complete_deal()
    resp = APIClient().get(f"/v1/reputation/profiles/{contractor_profile_id}/insights")
    assert resp.status_code in (401, 403), resp.content


def test_insights_ownership_does_not_depend_on_the_acting_profile_header():
    """Владелец, забывший переключить актёра, получает СВОИ данные, а не
    403: право проверяется владением профилем, не заголовком."""
    _customer, contractor, _customer_profile_id, contractor_profile_id = _complete_deal()
    resp = APIClient().get(
        f"/v1/reputation/profiles/{contractor_profile_id}/insights",
        **_auth_headers(contractor),
    )
    assert resp.status_code == 200, resp.content
