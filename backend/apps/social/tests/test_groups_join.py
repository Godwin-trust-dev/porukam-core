"""Объединения: вход/выход/заявки/хендл (отсмотр 2026-08-23). Каждый
запрет — отдельным тестом: свободный вход только при join_policy=open;
закрытое — заявка до решения лидера/админа; лидер не выходит; хендл группы —
общая уникальность с пользовательскими."""

from __future__ import annotations

import pytest
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.social import selectors, services
from apps.social.models import AddressableGroup, GroupMembership

pytestmark = pytest.mark.django_db


def _user(suffix: str) -> User:
    return User.objects.create(trust_id=f"trust-grp-{suffix}", phone=f"+7999093{suffix}")


@pytest.fixture
def leader():
    return _user("001")


_HANDLE_SEQ = iter(range(10_000))


def _group(leader: User, policy: str = AddressableGroup.JoinPolicy.OPEN) -> AddressableGroup:
    return services.create_group(
        leader,
        kind=AddressableGroup.Kind.COMMUNITY,
        name="Мастера плитки",
        handle=f"tilers_{next(_HANDLE_SEQ)}",
        sphere_code="it",
        join_policy=policy,
    )


def test_open_group_join_and_leave(leader):
    group = _group(leader)
    user = _user("002")
    membership = services.join_group(group, user)
    assert membership.status == GroupMembership.Status.ACTIVE
    assert membership.joined_at is not None
    # Идемпотентно.
    assert services.join_group(group, user).id == membership.id

    services.leave_group(group, user)
    membership.refresh_from_db()
    assert membership.status == GroupMembership.Status.LEFT
    # Повторный выход — no-op.
    services.leave_group(group, user)


def test_closed_group_join_creates_request(leader):
    group = _group(leader, AddressableGroup.JoinPolicy.APPROVAL)
    user = _user("003")
    membership = services.join_group(group, user)
    assert membership.status == GroupMembership.Status.REQUESTED
    assert membership.joined_at is None


def test_leader_approves_request(leader):
    group = _group(leader, AddressableGroup.JoinPolicy.APPROVAL)
    user = _user("004")
    membership = services.join_group(group, user)
    services.decide_join_request(group, leader, membership, approve=True)
    membership.refresh_from_db()
    assert membership.status == GroupMembership.Status.ACTIVE


def test_leader_rejects_request(leader):
    group = _group(leader, AddressableGroup.JoinPolicy.APPROVAL)
    user = _user("005")
    membership = services.join_group(group, user)
    services.decide_join_request(group, leader, membership, approve=False)
    membership.refresh_from_db()
    assert membership.status == GroupMembership.Status.LEFT


def test_member_cannot_decide_requests(leader):
    group = _group(leader, AddressableGroup.JoinPolicy.APPROVAL)
    requester = _user("006")
    outsider = _user("007")
    membership = services.join_group(group, requester)
    with pytest.raises(services.GroupPermissionDeniedError):
        services.decide_join_request(group, outsider, membership, approve=True)


def test_decide_twice_rejected(leader):
    group = _group(leader, AddressableGroup.JoinPolicy.APPROVAL)
    user = _user("008")
    membership = services.join_group(group, user)
    services.decide_join_request(group, leader, membership, approve=True)
    with pytest.raises(services.JoinRequestNotPendingError):
        services.decide_join_request(group, leader, membership, approve=True)


def test_invited_user_joins_via_join(leader):
    group = _group(leader, AddressableGroup.JoinPolicy.APPROVAL)
    invitee = _user("009")
    services.invite_member(group, leader, invitee, role=GroupMembership.Role.MEMBER)
    membership = services.join_group(group, invitee)
    assert membership.status == GroupMembership.Status.ACTIVE


def test_leader_cannot_leave(leader):
    group = _group(leader)
    with pytest.raises(services.LeaderCannotLeaveError):
        services.leave_group(group, leader)


def test_group_handle_set_and_search(leader):
    group = _group(leader)
    services.set_group_handle(group, leader, value="@Masters_Tile")
    handle = selectors.active_group_handle(group)
    assert handle is not None and handle.value == "masters_tile"

    assert group in selectors.search_groups("@masters")
    assert group in selectors.search_groups("Мастера")
    assert selectors.search_groups("плотники") == []


def test_group_handle_conflicts_with_user_handle(leader):
    other = _user("010")
    services.claim_handle(user=other, value="occupied")
    group = _group(leader)
    with pytest.raises(services.HandleTakenError):
        services.set_group_handle(group, leader, value="occupied")


def test_member_cannot_set_group_handle(leader):
    group = _group(leader)
    member = _user("011")
    services.join_group(group, member)
    with pytest.raises(services.GroupPermissionDeniedError):
        services.set_group_handle(group, member, value="sneaky")


# --- HTTP-слой ---------------------------------------------------------------


def test_http_join_leave_and_members(leader):
    group = _group(leader)
    user = _user("012")
    client = APIClient()
    client.force_authenticate(user=user)

    resp = client.post(f"/v1/groups/{group.id}/join")
    assert resp.status_code == 200, resp.content
    assert resp.data["status"] == "active"

    members = client.get(f"/v1/groups/{group.id}/members")
    assert members.status_code == 200
    assert {m["status"] for m in members.data} == {"active"}

    detail = client.get(f"/v1/groups/{group.id}")
    assert detail.data["my_membership"] == {"role": "member", "status": "active"}
    assert detail.data["members_count"] == 2

    assert client.post(f"/v1/groups/{group.id}/leave").status_code == 204


def test_http_request_flow_closed_group(leader):
    group = _group(leader, AddressableGroup.JoinPolicy.APPROVAL)
    user = _user("013")
    user_client = APIClient()
    user_client.force_authenticate(user=user)
    joined = user_client.post(f"/v1/groups/{group.id}/join")
    assert joined.data["status"] == "requested"

    leader_client = APIClient()
    leader_client.force_authenticate(user=leader)
    decided = leader_client.post(f"/v1/groups/{group.id}/requests/{joined.data['id']}/approve")
    assert decided.status_code == 200, decided.content
    assert decided.data["status"] == "active"


def test_http_group_handle(leader):
    group = _group(leader)
    client = APIClient()
    client.force_authenticate(user=leader)
    resp = client.post(f"/v1/groups/{group.id}/handle", {"value": "tile_pro"}, format="json")
    assert resp.status_code == 200, resp.content
    assert resp.data["handle"] == "@tile_pro"


def test_http_invite_by_handle(leader):
    group = _group(leader)
    invitee = _user("014")
    services.claim_handle(user=invitee, value="invite_me")
    client = APIClient()
    client.force_authenticate(user=leader)
    resp = client.post(f"/v1/groups/{group.id}/members", {"handle": "@invite_me"}, format="json")
    assert resp.status_code == 201, resp.content
    membership = selectors.my_membership(group, invitee)
    assert membership is not None and membership.status == "invited"


def test_join_request_notifies_leader_via_outbox(leader):
    """Заявка в закрытое объединение — событие с явным адресатом-лидером
    (payload.notify_user_id: social не зовёт notifications напрямую —
    import-linter)."""
    from common.models import OutboxEvent

    group = _group(leader, AddressableGroup.JoinPolicy.APPROVAL)
    requester = _user("015")
    services.join_group(group, requester)
    event = OutboxEvent.objects.filter(topic="group.join_requested").latest("occurred_at")
    assert event.payload["notify_user_id"] == str(leader.id)
    assert event.payload["group_name"] == group.name


def test_invite_notifies_invitee_via_outbox(leader):
    from common.models import OutboxEvent

    group = _group(leader)
    invitee = _user("016")
    services.invite_member(group, leader, invitee, role=GroupMembership.Role.MEMBER)
    event = OutboxEvent.objects.filter(topic="group.invited").latest("occurred_at")
    assert event.payload["notify_user_id"] == str(invitee.id)


def test_approve_notifies_requester_via_outbox(leader):
    from common.models import OutboxEvent

    group = _group(leader, AddressableGroup.JoinPolicy.APPROVAL)
    requester = _user("017")
    membership = services.join_group(group, requester)
    services.decide_join_request(group, leader, membership, approve=True)
    event = OutboxEvent.objects.filter(topic="group.request_approved").latest("occurred_at")
    assert event.payload["notify_user_id"] == str(requester.id)
