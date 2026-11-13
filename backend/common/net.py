"""Определение адреса клиента за нашим прокси — для лимитов и проверок доступа.

Причина (ADR-145/168): X-Forwarded-For клиент подделывает — nginx лишь
дописывает адрес справа, а первый элемент остаётся клиентским. Взяв его, можно
обойти любой rate-limit по IP. Поэтому источник — X-Real-IP, который наш nginx
каждый раз ПЕРЕЗАПИСЫВАЕТ значением `$remote_addr` (после real_ip по доверенным
диапазонам Cloudflare, конфигурация nginx), и только если
соединение пришло от доверенного прокси.
"""

from __future__ import annotations

import ipaddress

from django.http import HttpRequest
from rest_framework.request import Request

_TRUSTED_PROXY_NETS = tuple(
    ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7")
)


def is_trusted_proxy(address: str) -> bool:
    """Прямой сосед — наш nginx в сети compose (частный адрес) или loopback."""
    try:
        parsed = ipaddress.ip_address(address)
    except ValueError:
        return False
    # is_private у ipaddress включает и документационные диапазоны (TEST-NET),
    # поэтому сети перечислены явно.
    return parsed.is_loopback or any(parsed in net for net in _TRUSTED_PROXY_NETS)


def client_ip(request: HttpRequest | Request) -> str:
    """Адрес клиента: X-Real-IP от доверенного прокси, иначе REMOTE_ADDR.
    X-Forwarded-For не используется никогда."""
    remote = str(request.META.get("REMOTE_ADDR") or "")
    real_ip = str(request.META.get("HTTP_X_REAL_IP", "")).strip()
    if real_ip and is_trusted_proxy(remote):
        try:
            return str(ipaddress.ip_address(real_ip))
        except ValueError:
            return remote
    return remote
