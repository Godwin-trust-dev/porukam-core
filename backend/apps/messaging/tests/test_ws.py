"""WebSocket чата (ADR-113): auth первым кадром, подписка только стороной,
кадр сообщения долетает в группу. Channel layer в тестах — in-memory
(config/settings/test.py), Redis не нужен."""

from __future__ import annotations

import pytest
from channels.db import database_sync_to_async
from channels.testing import WebsocketCommunicator
from rest_framework_simplejwt.tokens import AccessToken

from apps.contracts import services as contracts_services
from apps.contracts.models import Contract, ContractParty
from apps.contracts.tests._signing_helpers import make_user
from apps.messaging import services
from apps.messaging.consumers import ChatConsumer
from apps.profiles.models import Profile

# serialized_rollback: транзакционный тест делает flush ВСЕХ таблиц — без
# восстановления сериализованных data-миграций (юрисдикции, валюты каталога,
# l10n-паки) он оставляет reuse-db БД пустой для следующих прогонов.
pytestmark = [
    pytest.mark.django_db(
        transaction=True, serialized_rollback=True, databases=["default", "audit"]
    )
]


def _token(user) -> str:
    return str(AccessToken.for_user(user))


@database_sync_to_async
def _fixture():
    customer = make_user("ws-cst")
    contractor = make_user("ws-ctr")
    contractor_profile = Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=contractor, profile_visibility="link_and_deals"
    )
    contract = contracts_services.create_draft(
        user=customer,
        my_role=ContractParty.Role.CUSTOMER,
        client_option="service",
        counterparty_profile_id=contractor_profile.id,
        payment_method=Contract.PaymentMethod.CASH,
        title="WS-переписка",
    )
    return customer, contractor, contract


async def _connect() -> WebsocketCommunicator:
    communicator = WebsocketCommunicator(ChatConsumer.as_asgi(), "/ws/chat")
    connected, _ = await communicator.connect()
    assert connected
    return communicator


@pytest.mark.asyncio
async def test_auth_and_subscribe_party():
    customer, _contractor, contract = await _fixture()
    ws = await _connect()
    try:
        await ws.send_json_to({"type": "auth", "token": _token(customer)})
        assert (await ws.receive_json_from())["type"] == "auth_ok"
        await ws.send_json_to({"type": "subscribe", "contract_id": str(contract.id)})
        reply = await ws.receive_json_from()
        assert reply == {"type": "subscribed", "contract_id": str(contract.id)}
    finally:
        await ws.disconnect()


@pytest.mark.asyncio
async def test_invalid_token_closes():
    ws = await _connect()
    reply = None
    try:
        await ws.send_json_to({"type": "auth", "token": "broken"})
        reply = await ws.receive_json_from()
    finally:
        await ws.disconnect()
    assert reply == {"type": "error", "code": "invalid_token"}


@pytest.mark.asyncio
async def test_stranger_subscribe_gets_not_found():
    _customer, _contractor, contract = await _fixture()
    stranger = await database_sync_to_async(make_user)("ws-str")
    ws = await _connect()
    try:
        await ws.send_json_to({"type": "auth", "token": _token(stranger)})
        assert (await ws.receive_json_from())["type"] == "auth_ok"
        await ws.send_json_to({"type": "subscribe", "contract_id": str(contract.id)})
        assert await ws.receive_json_from() == {"type": "error", "code": "not_found"}
    finally:
        await ws.disconnect()


@pytest.mark.asyncio
async def test_subscribe_without_auth_rejected():
    _customer, _contractor, contract = await _fixture()
    ws = await _connect()
    try:
        await ws.send_json_to({"type": "subscribe", "contract_id": str(contract.id)})
        assert await ws.receive_json_from() == {"type": "error", "code": "auth_required"}
    finally:
        await ws.disconnect()


@pytest.mark.asyncio
async def test_message_frame_reaches_subscriber():
    customer, contractor, contract = await _fixture()
    ws = await _connect()
    try:
        await ws.send_json_to({"type": "auth", "token": _token(contractor)})
        await ws.receive_json_from()
        await ws.send_json_to({"type": "subscribe", "contract_id": str(contract.id)})
        await ws.receive_json_from()

        await database_sync_to_async(services.send_message)(
            contract, user=customer, body="Привет по проводу!"
        )

        frame = await ws.receive_json_from(timeout=3)
        assert frame["type"] == "message"
        assert frame["contract_id"] == str(contract.id)
        assert frame["message"]["body"] == "Привет по проводу!"
    finally:
        await ws.disconnect()
