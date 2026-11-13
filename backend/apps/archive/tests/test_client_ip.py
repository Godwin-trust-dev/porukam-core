"""Адрес клиента для лимита ссылок архива (без БД)."""

from __future__ import annotations

import pytest
from rest_framework.test import APIClient

from apps.archive import services


def test_link_rate_limit_ignores_spoofed_forwarded_for(monkeypatch: pytest.MonkeyPatch) -> None:
    """Подделка X-Forwarded-For не даёт обойти лимит ссылок: ключ — адрес
    соединения (ADR-145/168)."""
    seen: list[str] = []

    def fake_limit(ip: str) -> None:
        seen.append(ip)
        raise services.ArchiveLinkRateLimitedError("лимит")

    monkeypatch.setattr(services, "check_link_rate_limit", fake_limit)
    anon = APIClient()
    for spoof in ("198.51.100.1", "198.51.100.2"):
        resp = anon.get("/a/whatever", REMOTE_ADDR="203.0.113.77", HTTP_X_FORWARDED_FOR=spoof)
        assert resp.status_code == 429
    assert seen == ["203.0.113.77", "203.0.113.77"]
