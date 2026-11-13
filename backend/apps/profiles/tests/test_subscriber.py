"""docs/tasks/etap-3-delta-adr059.md §2 тест 6: смена согласия profile_public
на «нет» после регистрации -> карточка немедленно пропадает из каталога.
Тот же приём проверки «немедленности», что apps/notifications/tests/
test_subscriber.py (ЭФ.4): relay доставляется синхронно в тесте, а не по
таймеру Celery beat."""

from __future__ import annotations

import pytest
from django.utils import timezone

from apps.accounts.models import User
from apps.entities import services as entities_services
from apps.entities.providers import FakeEntityRegistryProvider
from apps.identity import services as identity_services
from apps.identity.providers import FakeEsiaProvider
from apps.profiles import selectors
from apps.profiles.models import Profile
from apps.profiles.subscriber import handle_event
from apps.social import services as social_services
from apps.social.models import Consent
from common import relay
from common.models import OutboxEvent

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

_esia = FakeEsiaProvider()
_registry = FakeEntityRegistryProvider()


def _verify(user: User, *, full_name: str, tax_id: str) -> None:
    _url, state = identity_services.build_authorize_url(user, provider=_esia)
    identity_services.complete_verification(
        user, code=f"{full_name}|{tax_id}", state=state, provider=_esia
    )
    user.refresh_from_db()


@pytest.fixture
def user() -> User:
    return User.objects.create(trust_id="trust-profiles-sub-1", phone="+79990850001")


def test_consent_recorded_creates_person_profile_lazily(user: User):
    social_services.record_consent(
        user, consent_type=Consent.ConsentType.PROFILE_PUBLIC, value=True
    )
    event = OutboxEvent.objects.get(topic="social.consent_recorded", subject__id=str(user.id))
    handle_event(event)

    profile = Profile.objects.get(kind=Profile.Kind.PERSON, owner_user=user)
    assert profile.profile_visibility == Profile.Visibility.PUBLIC


def test_revoking_profile_public_removes_from_catalog_immediately(user: User):
    social_services.record_consent(
        user, consent_type=Consent.ConsentType.PROFILE_PUBLIC, value=True
    )
    delivered = relay.deliver_due_events()
    assert delivered >= 1
    profile = Profile.objects.get(kind=Profile.Kind.PERSON, owner_user=user)
    assert profile in list(selectors.list_catalog_profiles())

    social_services.record_consent(
        user, consent_type=Consent.ConsentType.PROFILE_PUBLIC, value=False
    )
    delivered = relay.deliver_due_events()
    assert delivered >= 1

    profile.refresh_from_db()
    assert profile.profile_visibility == Profile.Visibility.LINK_AND_DEALS
    assert profile not in list(selectors.list_catalog_profiles())


def test_handle_event_ignores_other_consent_types(user: User):
    social_services.record_consent(user, consent_type=Consent.ConsentType.PD_PROCESSING, value=True)
    event = OutboxEvent.objects.get(topic="social.consent_recorded", subject__id=str(user.id))
    handle_event(event)
    assert not Profile.objects.filter(owner_user=user).exists()


def test_handle_event_ignores_unmapped_topic():
    event = OutboxEvent.objects.create(
        topic="unmapped.topic", occurred_at=timezone.now(), actor={}, subject={}, payload={}
    )
    handle_event(event)  # не бросает, просто no-op


# --- account.logged_in: авто-создание при регистрации (etap-3.md 3.5) ------


def test_account_logged_in_creates_person_profile_eagerly(user: User):
    """docs/adr/ADR-074: видимость по умолчанию LINK_AND_DEALS — profile_public
    ещё неизвестен, дефолт консервативный, не public."""
    event = OutboxEvent.objects.create(
        topic="account.logged_in",
        occurred_at=timezone.now(),
        actor={"user_id": str(user.id)},
        subject={"type": "user", "id": str(user.id)},
        payload={"created": True},
    )
    handle_event(event)

    profile = Profile.objects.get(kind=Profile.Kind.PERSON, owner_user=user)
    assert profile.profile_visibility == Profile.Visibility.LINK_AND_DEALS


def test_account_logged_in_ignores_repeat_logins(user: User):
    event = OutboxEvent.objects.create(
        topic="account.logged_in",
        occurred_at=timezone.now(),
        actor={"user_id": str(user.id)},
        subject={"type": "user", "id": str(user.id)},
        payload={"created": False},
    )
    handle_event(event)
    assert not Profile.objects.filter(owner_user=user).exists()


# --- entity.claimed: бизнес-профиль по claim'нутому юрлицу ------------------


def test_entity_claimed_creates_business_profile(user: User):
    _verify(
        user,
        full_name="Пётр Сергеевич Кузнецов",
        tax_id=FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN,
    )
    entity = entities_services.register_business_entity(
        FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN,
        country="RU",
        created_by=user,
        provider=_registry,
    )

    event = OutboxEvent.objects.get(topic="entity.claimed", subject__id=str(entity.id))
    handle_event(event)

    profile = Profile.objects.get(kind=Profile.Kind.BUSINESS, owner_entity=entity)
    assert profile.profile_visibility == Profile.Visibility.PUBLIC


def test_entity_claimed_relay_end_to_end(user: User):
    _verify(
        user,
        full_name="Анна Викторовна Смирнова",
        tax_id=FakeEntityRegistryProvider.SELF_EMPLOYED_INN,
    )
    entity = entities_services.register_business_entity(
        FakeEntityRegistryProvider.SELF_EMPLOYED_INN,
        country="RU",
        created_by=user,
        provider=_registry,
    )
    delivered = relay.deliver_due_events()
    assert delivered >= 1
    assert Profile.objects.filter(kind=Profile.Kind.BUSINESS, owner_entity=entity).exists()
