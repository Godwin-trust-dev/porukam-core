"""API apps.archive (ADR-139): превью, 202 + Idempotency-Key, доступ только
сторонам, поллинг, `/a/<token>` (200 -> 410 после shred, отзыв, рейт-лимит,
no-store)."""

from __future__ import annotations

import pytest
from django.test import override_settings
from rest_framework.test import APIClient

from apps.archive import services
from apps.archive.storage import FakeArchiveObjectStore
from apps.milestones.tests._execution_helpers import make_user

from ._helpers import RecordingEmailProvider, checkpoint, make_deal, relay_all, upload

pytestmark = pytest.mark.django_db(databases=["default", "audit"])


def _client(user) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _ready_export(contract, contractor, store):
    export = services.request_export(contract, user=contractor)
    archive_store = FakeArchiveObjectStore()
    services.build_export(
        export,
        evidence_store=store,
        archive_store=archive_store,
        email_provider=RecordingEmailProvider(),
    )
    export.refresh_from_db()
    return export, archive_store


def _token(url: str) -> str:
    return url.rsplit("/a/", 1)[1]


def test_preview_symmetric_and_only_for_parties():
    contract, milestone, customer, contractor, store = make_deal("t1")
    upload(contract, milestone, contractor, store)
    for user in (customer, contractor):
        resp = _client(user).get(f"/v1/contracts/{contract.id}/archive")
        assert resp.status_code == 200, resp.content
        assert resp.data["contract_status"] == "in_work"
        assert resp.data["is_snapshot"] is True
        assert resp.data["can_export"] is True
        assert resp.data["format"] == {"pdf": False, "zip": True, "html": True}
        keys = [s["key"] for s in resp.data["sections"]]
        assert keys == ["contract", "milestones", "events", "evidence", "payments"]
        assert resp.data["sections"][3]["count"] == 1
        assert resp.data["exports"] == []
    stranger = make_user("a9t1")
    assert _client(stranger).get(f"/v1/contracts/{contract.id}/archive").status_code == 403
    assert APIClient().get(f"/v1/contracts/{contract.id}/archive").status_code == 401


def test_export_post_returns_202_and_is_idempotent(django_capture_on_commit_callbacks):
    contract, milestone, _customer, contractor, store = make_deal("t2")
    upload(contract, milestone, contractor, store)
    client = _client(contractor)
    url = f"/v1/contracts/{contract.id}/archive/export"
    body = {"include_originals": True, "manifest_only": False}

    resp = client.post(url, body, format="json")
    assert resp.status_code == 400 and resp.data["code"] == "idempotency_key_required"

    with override_settings(EVIDENCE_OBJECT_STORE="fake", ARCHIVE_OBJECT_STORE="fake"):
        from apps.evidence import storage as evidence_storage

        evidence_storage._fake_store.objects.update(store.objects)
        with django_capture_on_commit_callbacks(execute=True):
            resp = client.post(url, body, format="json", HTTP_IDEMPOTENCY_KEY="k-1")
    assert resp.status_code == 202, resp.content
    export_id = resp.data["export_id"]
    assert resp.data["jobId"] == export_id
    assert resp.data["status"] == "queued"

    again = client.post(url, body, format="json", HTTP_IDEMPOTENCY_KEY="k-1")
    assert again.status_code == 202 and again.data["export_id"] == export_id
    conflict = client.post(url, {"manifest_only": True}, format="json", HTTP_IDEMPOTENCY_KEY="k-1")
    assert conflict.status_code == 409 and conflict.data["code"] == "idempotency_key_reused"
    bad = client.post(
        url,
        {"include_originals": True, "manifest_only": True},
        format="json",
        HTTP_IDEMPOTENCY_KEY="k-2",
    )
    assert bad.status_code == 422 and bad.data["code"] == "archive_options_conflict"

    # Celery eager: задача выполнилась на коммите — экспорт готов.
    detail = client.get(f"/v1/contracts/{contract.id}/archive/export/{export_id}")
    assert detail.status_code == 200, detail.content
    assert detail.data["status"] == "ready", detail.data["error"]
    assert detail.data["progress"] == 100
    assert detail.data["pdf"] is None
    assert detail.data["package"]["url"].startswith("http://localhost:5173/a/")
    assert detail.data["zip"]["url"].startswith("http://localhost:5173/a/")
    assert detail.data["zip"]["state"] == "available"
    # Сторона видит только свои ссылки; у контрагента url тех же ссылок — null.
    mine = [link for link in detail.data["links"] if link["party_role"] == "contractor"]
    other = [link for link in detail.data["links"] if link["party_role"] == "customer"]
    assert all(link["url"] for link in mine) and all(link["url"] is None for link in other)
    stranger = make_user("a9t2")
    assert (
        _client(stranger).get(f"/v1/contracts/{contract.id}/archive/export/{export_id}").status_code
        == 403
    )


def test_public_link_streams_zip_then_410_after_shred(monkeypatch):
    contract, milestone, _customer, contractor, store = make_deal("t3")
    upload(contract, milestone, contractor, store)
    relay_all()
    checkpoint()
    export, archive_store = _ready_export(contract, contractor, store)
    monkeypatch.setattr(services, "build_archive_object_store", lambda: archive_store)
    files_link = export.links.get(kind="files", party_role="contractor")
    package_link = export.links.get(kind="package", party_role="contractor")
    files_token = services.link_token_for_party(files_link)
    package_token = services.link_token_for_party(package_link)

    anon = APIClient()
    resp = anon.get(f"/a/{files_token}")
    assert resp.status_code == 200, resp.content
    assert resp["Cache-Control"] == "private, no-store"
    assert resp["Content-Type"] == "application/zip"
    assert resp.content.startswith(b"PK")
    assert resp["X-Content-Sha256"] == export.files_sha256
    files_link.refresh_from_db()
    assert files_link.access_count == 1 and files_link.last_access_at is not None

    assert anon.get("/a/not-a-token").status_code == 404

    services.shred_export_files(contract.id, archive_store=archive_store)
    resp = anon.get(f"/a/{files_token}")
    assert resp.status_code == 410, resp.content
    assert resp["Cache-Control"] == "private, no-store"
    body = resp.json()
    assert body["code"] == "archive_files_shredded"
    assert body["shredded_at"]
    assert body["package_url"] == services.link_url(package_token)
    assert body["sha256sums"].startswith(export.sha256sums[:20])
    html = anon.get(f"/a/{files_token}", HTTP_ACCEPT="text/html")
    assert html.status_code == 410 and b"SHA256SUMS" in html.content
    # Пакет — по-прежнему.
    resp = anon.get(f"/a/{package_token}")
    assert resp.status_code == 200 and resp["Content-Disposition"].endswith('"package.zip"')

    from common.models import OutboxEvent

    assert OutboxEvent.objects.filter(topic="archive.link_accessed").count() == 4


def test_revoke_endpoint_and_rate_limit(monkeypatch):
    contract, milestone, customer, contractor, store = make_deal("t4")
    upload(contract, milestone, contractor, store)
    relay_all()
    export, archive_store = _ready_export(contract, contractor, store)
    monkeypatch.setattr(services, "build_archive_object_store", lambda: archive_store)
    link = export.links.get(kind="package", party_role="customer")
    token = services.link_token_for_party(link)

    stranger = make_user("a9t4")
    assert _client(stranger).post(f"/v1/archive/links/{link.id}/revoke").status_code == 403
    resp = _client(customer).post(f"/v1/archive/links/{link.id}/revoke")
    assert resp.status_code == 200 and resp.data["revoked_at"]
    resp = APIClient().get(f"/a/{token}")
    assert resp.status_code == 410 and resp.json()["code"] == "archive_link_revoked"

    other = services.link_token_for_party(export.links.get(kind="package", party_role="contractor"))
    with override_settings(ARCHIVE_LINK_RATE_LIMIT=2):
        anon = APIClient()
        ip = {"REMOTE_ADDR": "203.0.113.77"}
        assert anon.get(f"/a/{other}", **ip).status_code == 200
        assert anon.get(f"/a/{other}", **ip).status_code == 200
        limited = anon.get(f"/a/{other}", **ip)
        assert limited.status_code == 429
        assert limited["Retry-After"]
        assert limited["Cache-Control"] == "private, no-store"
