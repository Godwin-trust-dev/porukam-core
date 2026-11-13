"""Портфолио v2 (ADR-120): галерея до 5 фото (первое — основное),
обязательная дата завершения, редактирование сферы/дат."""

from __future__ import annotations

import datetime as dt
import io

import pytest
from PIL import Image
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.profiles import services
from apps.profiles.models import PortfolioPhoto, Profile
from apps.profiles.storage import reset_fake_store

pytestmark = pytest.mark.django_db


def _png(color: tuple[int, int, int] = (200, 120, 40)) -> io.BytesIO:
    buffer = io.BytesIO()
    Image.new("RGB", (640, 480), color).save(buffer, format="PNG")
    buffer.seek(0)
    return buffer


@pytest.fixture(autouse=True)
def _fake_store(settings):
    settings.PROFILE_AVATAR_STORE = "fake"
    reset_fake_store()


@pytest.fixture
def owner():
    return User.objects.create(trust_id="trust-pf-v2", phone="+79990960001")


@pytest.fixture
def profile(owner):
    return Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=owner, profile_visibility="public"
    )


@pytest.fixture
def client(owner):
    client = APIClient()
    client.force_authenticate(user=owner)
    return client


@pytest.fixture
def project(profile, owner):
    return services.create_portfolio_project(
        profile,
        owner,
        title="Кухня под ключ",
        sphere="renovation",
        completed_at=dt.date(2026, 5, 1),
    )


def _add(client, project_id):
    return client.post(
        f"/v1/portfolio/projects/{project_id}/photos", {"file": _png()}, format="multipart"
    )


def test_completed_at_required_on_create(client, profile):
    resp = client.post(
        f"/v1/profiles/{profile.id}/portfolio/projects",
        {"title": "Без даты", "sphere": "renovation"},
        format="json",
    )
    assert resp.status_code == 400  # DRF: обязательное поле сериализатора
    ok = client.post(
        f"/v1/profiles/{profile.id}/portfolio/projects",
        {
            "title": "С датой",
            "sphere": "renovation",
            "completed_at": "2026-05-01",
            "location_label": "Алматы",
        },
        format="json",
    )
    assert ok.status_code == 201, ok.content
    assert ok.data["completed_at"] == "2026-05-01"
    assert ok.data["started_at"] is None
    assert ok.data["photos"] == []


def test_started_after_completed_is_422(client, profile):
    resp = client.post(
        f"/v1/profiles/{profile.id}/portfolio/projects",
        {
            "title": "Даты наоборот",
            "sphere": "it",
            "started_at": "2026-06-01",
            "completed_at": "2026-05-01",
        },
        format="json",
    )
    assert resp.status_code == 422
    assert resp.data["code"] == "portfolio_dates_invalid"


def test_patch_edits_sphere_and_dates(client, project):
    resp = client.patch(
        f"/v1/portfolio/projects/{project.id}",
        {
            "sphere": "design",
            "started_at": "2026-04-01",
            "completed_at": "2026-05-10",
            "title": "Кухня",
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["sphere"] == "design"
    assert resp.data["started_at"] == "2026-04-01"
    assert resp.data["completed_at"] == "2026-05-10"
    assert resp.data["title"] == "Кухня"
    # Снять дату начала можно явным null, дату завершения — нет.
    cleared = client.patch(
        f"/v1/portfolio/projects/{project.id}", {"started_at": None}, format="json"
    )
    assert cleared.status_code == 200 and cleared.data["started_at"] is None
    bad = client.patch(
        f"/v1/portfolio/projects/{project.id}", {"completed_at": None}, format="json"
    )
    assert bad.status_code == 400


def test_gallery_add_up_to_five_first_is_primary_and_cover(client, project):
    ids = []
    for _ in range(5):
        resp = _add(client, project.id)
        assert resp.status_code == 201, resp.content
        ids.append(resp.data["photos"][-1]["id"])
    assert [p["order"] for p in resp.data["photos"]] == [0, 1, 2, 3, 4]
    assert resp.data["photos"][0]["is_primary"] is True
    assert resp.data["photos"][1]["is_primary"] is False
    # Обложка (совместимость ADR-115) = основное фото.
    assert resp.data["photo_url"] is not None
    project.refresh_from_db()
    assert project.photo_key == PortfolioPhoto.objects.get(pk=ids[0]).photo_key

    sixth = _add(client, project.id)
    assert sixth.status_code == 409
    assert sixth.data["code"] == "portfolio_photos_limit"


def test_photo_bytes_public_delete_and_primary_switch(client, project):
    first = _add(client, project.id).data["photos"][0]
    second = _add(client, project.id).data["photos"][1]

    guest = APIClient()
    shown = guest.get(f"/v1/portfolio/projects/{project.id}/photos/{second['id']}", {"size": "320"})
    assert shown.status_code == 200
    assert shown["Content-Type"] == "image/webp"
    assert Image.open(io.BytesIO(shown.content)).size == (320, 240)

    promoted = client.post(f"/v1/portfolio/projects/{project.id}/photos/{second['id']}/primary")
    assert promoted.status_code == 200
    assert promoted.data["photos"][0]["id"] == second["id"]
    assert promoted.data["photos"][0]["is_primary"] is True
    project.refresh_from_db()
    assert project.photo_key == PortfolioPhoto.objects.get(pk=second["id"]).photo_key

    removed = client.delete(f"/v1/portfolio/projects/{project.id}/photos/{second['id']}")
    assert removed.status_code == 200
    assert [p["id"] for p in removed.data["photos"]] == [first["id"]]
    assert removed.data["photos"][0]["order"] == 0
    assert (
        guest.get(f"/v1/portfolio/projects/{project.id}/photos/{second['id']}").status_code == 404
    )
    project.refresh_from_db()
    assert project.photo_key == PortfolioPhoto.objects.get(pk=first["id"]).photo_key


def test_legacy_cover_endpoints_drive_primary_photo(client, project):
    cover = client.post(
        f"/v1/portfolio/projects/{project.id}/photo", {"file": _png()}, format="multipart"
    )
    assert cover.status_code == 200
    assert len(cover.data["photos"]) == 1
    replaced = client.post(
        f"/v1/portfolio/projects/{project.id}/photo",
        {"file": _png((10, 20, 30))},
        format="multipart",
    )
    assert replaced.status_code == 200
    assert len(replaced.data["photos"]) == 1  # замена, не второе фото
    assert replaced.data["photo_url"] != cover.data["photo_url"]
    removed = client.delete(f"/v1/portfolio/projects/{project.id}/photo")
    assert removed.status_code == 200
    assert removed.data["photos"] == [] and removed.data["photo_url"] is None


def test_gallery_write_requires_ownership(project):
    intruder = APIClient()
    intruder.force_authenticate(
        user=User.objects.create(trust_id="trust-pf-x", phone="+79990960002")
    )
    assert _add(intruder, project.id).status_code == 403


def test_photo_id_from_other_project_is_404(client, profile, owner, project):
    other = services.create_portfolio_project(
        profile, owner, title="Другой", sphere="it", completed_at=dt.date(2026, 1, 1)
    )
    photo_id = _add(client, project.id).data["photos"][0]["id"]
    assert client.delete(f"/v1/portfolio/projects/{other.id}/photos/{photo_id}").status_code == 404
