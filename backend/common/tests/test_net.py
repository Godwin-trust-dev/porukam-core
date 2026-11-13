"""client_ip: источник адреса клиента за нашим nginx (ADR-145/168)."""

from __future__ import annotations

import pytest
from django.test import RequestFactory

from common.net import client_ip, is_trusted_proxy

rf = RequestFactory()


def _ip(**meta: str) -> str:
    return client_ip(rf.get("/", **meta))


def test_spoofed_forwarded_for_ignored() -> None:
    assert _ip(REMOTE_ADDR="198.51.100.9", HTTP_X_FORWARDED_FOR="1.2.3.4") == "198.51.100.9"


def test_spoofed_forwarded_for_ignored_behind_proxy() -> None:
    meta = {
        "REMOTE_ADDR": "172.18.0.5",
        "HTTP_X_REAL_IP": "203.0.113.7",
        "HTTP_X_FORWARDED_FOR": "1.2.3.4, 203.0.113.7",
    }
    assert _ip(**meta) == "203.0.113.7"


@pytest.mark.parametrize(
    "remote", ["10.1.2.3", "172.18.0.5", "192.168.1.1", "127.0.0.1", "fd00::5"]
)
def test_real_ip_accepted_from_trusted_proxy(remote: str) -> None:
    assert _ip(REMOTE_ADDR=remote, HTTP_X_REAL_IP="203.0.113.7") == "203.0.113.7"


def test_real_ip_ignored_from_public_peer() -> None:
    assert _ip(REMOTE_ADDR="198.51.100.9", HTTP_X_REAL_IP="203.0.113.7") == "198.51.100.9"


def test_garbage_real_ip_falls_back_to_remote() -> None:
    assert _ip(REMOTE_ADDR="172.18.0.5", HTTP_X_REAL_IP="not-an-ip") == "172.18.0.5"


def test_ipv6_real_ip() -> None:
    assert _ip(REMOTE_ADDR="172.18.0.5", HTTP_X_REAL_IP="2001:db8::1") == "2001:db8::1"


def test_no_remote_addr_gives_empty() -> None:
    request = rf.get("/")
    request.META.pop("REMOTE_ADDR", None)
    assert client_ip(request) == ""


def test_test_net_is_not_trusted() -> None:
    assert not is_trusted_proxy("203.0.113.7")
    assert not is_trusted_proxy("garbage")
