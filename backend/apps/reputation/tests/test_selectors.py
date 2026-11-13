"""apps.reputation.selectors — видимость ADR-059 (docs/tasks/global-wave.md
ГВ.4: «видимость — public/link_and_deals по настройкам ADR-059; гостю —
стартовая карточка»), без сквозного Э4.6-сценария — DealFact/Profile
заводятся напрямую, это read-слой, а не подписчик."""

from __future__ import annotations

import pytest
from django.utils import timezone

from apps.profiles.models import Profile
from apps.reputation import selectors
from apps.reputation.models import DealFact

pytestmark = pytest.mark.django_db(databases=["default", "audit"])


def _profile(*, visibility: str, kind: str = Profile.Kind.PERSON) -> Profile:
    import apps.accounts.models as accounts_models

    owner_user = None
    owner_entity = None
    if kind == Profile.Kind.PERSON:
        owner_user = accounts_models.User.objects.create(
            trust_id=f"trust-sel-{Profile.objects.count()}",
            phone=f"+7999099{Profile.objects.count():04d}",
        )
    return Profile.objects.create(
        kind=kind, owner_user=owner_user, owner_entity=owner_entity, profile_visibility=visibility
    )


def test_public_profile_is_full_for_anonymous_guest():
    profile = _profile(visibility=Profile.Visibility.PUBLIC)
    assert selectors.card_visible_in_full(profile, viewer_profile_id=None) is True


def test_link_and_deals_profile_is_restricted_for_anonymous_guest():
    profile = _profile(visibility=Profile.Visibility.LINK_AND_DEALS)
    assert selectors.card_visible_in_full(profile, viewer_profile_id=None) is False


def test_link_and_deals_profile_is_full_for_owner_viewing_self():
    profile = _profile(visibility=Profile.Visibility.LINK_AND_DEALS)
    assert selectors.card_visible_in_full(profile, viewer_profile_id=profile.id) is True


def test_link_and_deals_profile_is_full_for_confirmed_counterparty():
    profile = _profile(visibility=Profile.Visibility.LINK_AND_DEALS)
    counterparty = _profile(visibility=Profile.Visibility.LINK_AND_DEALS)
    DealFact.objects.create(
        contract_id="00000000-0000-0000-0000-0000000000c1",
        customer_profile_id=profile.id,
        contractor_profile_id=counterparty.id,
        is_completed=True,
        completed_at=timezone.now(),
    )
    assert selectors.card_visible_in_full(profile, viewer_profile_id=counterparty.id) is True


def test_link_and_deals_profile_is_restricted_for_unrelated_authenticated_viewer():
    profile = _profile(visibility=Profile.Visibility.LINK_AND_DEALS)
    stranger = _profile(visibility=Profile.Visibility.LINK_AND_DEALS)
    assert selectors.card_visible_in_full(profile, viewer_profile_id=stranger.id) is False


def test_incomplete_deal_does_not_count_as_counterparty():
    profile = _profile(visibility=Profile.Visibility.LINK_AND_DEALS)
    counterparty = _profile(visibility=Profile.Visibility.LINK_AND_DEALS)
    DealFact.objects.create(
        contract_id="00000000-0000-0000-0000-0000000000c2",
        customer_profile_id=profile.id,
        contractor_profile_id=counterparty.id,
        is_completed=False,
    )
    assert selectors.is_counterparty(profile.id, counterparty.id) is False
    assert selectors.card_visible_in_full(profile, viewer_profile_id=counterparty.id) is False


def test_business_profile_is_always_full_regardless_of_visibility_field():
    import apps.accounts.models as accounts_models
    import apps.entities.models as entities_models

    founder = accounts_models.User.objects.create(
        trust_id="trust-sel-founder", phone="+79990999999"
    )
    entity = entities_models.BusinessEntity.objects.create(name="ООО Ромашка", created_by=founder)
    profile = Profile.objects.create(
        kind=Profile.Kind.BUSINESS,
        owner_entity=entity,
        profile_visibility=Profile.Visibility.PUBLIC,
    )
    assert selectors.card_visible_in_full(profile, viewer_profile_id=None) is True
