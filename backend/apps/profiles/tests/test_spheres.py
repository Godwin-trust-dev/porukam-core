"""ADR-122: заявленные сферы деятельности профиля (коды каталога, ≤ 10)."""

from __future__ import annotations

import pytest
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.catalog.models import Sphere
from apps.profiles import selectors, services
from apps.profiles.models import Profile

pytestmark = pytest.mark.django_db


@pytest.fixture
def owner():
    return User.objects.create(trust_id="trust-sph-1", phone="+79990970001")


@pytest.fixture
def profile(owner):
    return Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=owner, profile_visibility="public"
    )


@pytest.fixture
def spheres():
    return [
        Sphere.objects.get_or_create(code=code, defaults={"name_i18n": {"ru": code}})[0]
        for code in ("beauty", "repair", "it")
    ]


def test_update_spheres_dedupes_and_keeps_order(owner, profile, spheres):
    updated = services.update_profile(
        profile, owner, sphere_codes=["repair", "beauty", "repair", " it "]
    )
    assert updated.sphere_codes == ["repair", "beauty", "it"]


def test_update_spheres_rejects_unknown_and_limit(owner, profile, spheres):
    with pytest.raises(services.ProfileSpheresInvalidError):
        services.update_profile(profile, owner, sphere_codes=["nope"])
    with pytest.raises(services.ProfileSpheresLimitError):
        services.update_profile(profile, owner, sphere_codes=[f"s{i}" for i in range(11)])


def test_patch_profile_spheres_api(owner, profile, spheres):
    client = APIClient()
    client.force_authenticate(user=owner)
    resp = client.patch(
        f"/v1/profiles/{profile.id}", {"sphere_codes": ["beauty", "it"]}, format="json"
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["sphere_codes"] == ["beauty", "it"]

    bad = client.patch(f"/v1/profiles/{profile.id}", {"sphere_codes": ["nope"]}, format="json")
    assert bad.status_code == 422 and bad.data["code"] == "invalid_sphere"
    many = client.patch(
        f"/v1/profiles/{profile.id}", {"sphere_codes": [f"s{i}" for i in range(11)]}, format="json"
    )
    assert many.status_code == 422 and many.data["code"] == "profile_spheres_limit"

    # Публичная карточка профиля показывает сферы всем.
    shown = APIClient().get(f"/v1/profiles/{profile.id}")
    assert shown.status_code == 200 and shown.data["sphere_codes"] == ["beauty", "it"]


def test_declared_spheres_selector_respects_catalog_visibility(owner, profile, spheres):
    services.update_profile(profile, owner, sphere_codes=["beauty"])
    hidden_owner = User.objects.create(trust_id="trust-sph-2", phone="+79990970002")
    hidden = Profile.objects.create(
        kind=Profile.Kind.PERSON,
        owner_user=hidden_owner,
        profile_visibility="public",
        hide_from_catalog=True,
        sphere_codes=["beauty"],
    )
    found = selectors.profile_ids_with_declared_spheres(["beauty", "it"])
    assert found == [profile.id]
    assert hidden.id not in found


def test_reputation_card_carries_declared_spheres(owner, profile, spheres):
    services.update_profile(profile, owner, sphere_codes=["repair"])
    resp = APIClient().get(f"/v1/reputation/profiles/{profile.id}/card")
    assert resp.status_code == 200, resp.content
    assert resp.data["sphere_codes"] == ["repair"]
