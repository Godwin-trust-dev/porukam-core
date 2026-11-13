"""Приёмка ЭФ.1 (docs/tasks/fundament.md): claim юрлица публикует
entity.claimed через common.outbox, common.relay доставляет его
подписчику и выставляет published_at."""

from __future__ import annotations

import pytest
from django.test import override_settings

from apps.accounts.models import User
from apps.entities import services
from apps.entities.models import BusinessEntity
from apps.entities.providers import FakeEntityRegistryProvider
from apps.identity import services as identity_services
from apps.identity.providers import FakeEsiaProvider
from common import relay
from common.models import OutboxEvent

pytestmark = pytest.mark.django_db

_esia = FakeEsiaProvider()
_registry = FakeEntityRegistryProvider()

_seen_entity_claims: list[str] = []


def _on_entity_claimed(event: OutboxEvent) -> None:
    _seen_entity_claims.append(str(event.event_id))


def _verify(user: User, *, full_name: str, tax_id: str) -> None:
    _url, state = identity_services.build_authorize_url(user, provider=_esia)
    identity_services.complete_verification(
        user, code=f"{full_name}|{tax_id}", state=state, provider=_esia
    )


@override_settings(
    OUTBOX_SUBSCRIBERS={
        "entity.claimed": ["apps.entities.tests.test_outbox_relay._on_entity_claimed"],
    }
)
def test_claim_is_delivered_by_relay_and_marks_published_at():
    user = User.objects.create(trust_id="trust-relay-claim-1", phone="+79990900001")
    _verify(user, full_name="Пётр Кузнецов", tax_id=FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN)

    entity = services.register_business_entity(
        FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN,
        country="RU",
        created_by=user,
        provider=_registry,
    )
    assert entity.claim_status == BusinessEntity.ClaimStatus.CLAIMED

    event = OutboxEvent.objects.get(topic="entity.claimed", subject__id=str(entity.id))
    assert event.published_at is None

    delivered = relay.deliver_due_events()

    event.refresh_from_db()
    assert delivered >= 1  # + прочие события flow (identity/accounts) из того же sweep'а
    assert event.published_at is not None
    assert str(event.event_id) in _seen_entity_claims
