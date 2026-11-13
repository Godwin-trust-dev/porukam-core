"""ADR-135 «Дальнейшие шаги» п.4: проба доступности TSA из cron на боевом
хосте (latency/статус по каждому endpoint'у + внешний IP хоста в том же
логе — прогон с VPN/другой машины невалиден, см. ADR «Важно о методике»).
Одна JSON-строка на endpoint + одна на egress, stdout — cron дописывает в
лог (прод-конфиг «Обслуживание»)."""

from __future__ import annotations

import hashlib
import json
import secrets
import time
from datetime import UTC, datetime
from typing import Any

import httpx
from django.conf import settings
from django.core.management.base import BaseCommand

from services.audit_vault import tsa
from services.audit_vault.providers import USER_AGENT

EGRESS_URL = "https://ifconfig.co/json"


def probe_endpoint(url: str, *, client: httpx.Client) -> dict[str, Any]:
    imprint = hashlib.sha256(secrets.token_bytes(32)).digest()
    nonce = secrets.randbits(64) | 1
    started = time.monotonic()
    try:
        record = tsa.request_timestamp(
            url,
            imprint,
            alg="sha256",
            nonce=nonce,
            client=client,
            now=lambda: datetime.now(UTC),
            archive_pki=False,
        )
    except tsa.TsaError as exc:
        return {
            "tsa": url,
            "ok": False,
            "latency_ms": int((time.monotonic() - started) * 1000),
            "error": str(exc),
        }
    return {
        "tsa": url,
        "ok": True,
        "latency_ms": record.latency_ms,
        "gen_time": record.gen_time.isoformat(),
        "signer": record.signer,
        "warnings": record.warnings,
    }


def probe_egress(*, client: httpx.Client) -> dict[str, Any]:
    try:
        response = client.get(EGRESS_URL, headers={"Accept": "application/json"})
        response.raise_for_status()
        data = response.json()
        return {
            "ip": data.get("ip"),
            "country": data.get("country_iso") or data.get("country"),
            "asn": data.get("asn"),
        }
    except (httpx.HTTPError, ValueError) as exc:
        return {"error": str(exc)}


class Command(BaseCommand):
    help = "Проба доступности TSA (ADR-135): latency/статус каждого TSA_ENDPOINTS + внешний IP."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--endpoint", action="append", dest="endpoints", help="Переопределить TSA_ENDPOINTS"
        )
        parser.add_argument("--timeout", type=float, default=None)
        parser.add_argument("--no-egress", action="store_true", help="Не запрашивать внешний IP")

    def handle(self, *args: Any, **options: Any) -> None:
        endpoints: list[str] = options["endpoints"] or settings.TSA_ENDPOINTS
        timeout: float = options["timeout"] or settings.TSA_TIMEOUT
        at = datetime.now(UTC).isoformat()
        ok_count = 0
        with httpx.Client(
            timeout=timeout, follow_redirects=True, headers={"User-Agent": USER_AGENT}
        ) as client:
            if not options["no_egress"]:
                self.stdout.write(
                    json.dumps(
                        {"at": at, "kind": "egress", **probe_egress(client=client)},
                        ensure_ascii=False,
                    )
                )
            for url in endpoints:
                result = probe_endpoint(url, client=client)
                ok_count += int(result["ok"])
                self.stdout.write(
                    json.dumps({"at": at, "kind": "tsa", **result}, ensure_ascii=False)
                )
        summary = {
            "at": at,
            "kind": "summary",
            "ok": ok_count,
            "total": len(endpoints),
            "quorum": settings.TSA_QUORUM,
            "quorum_reached": ok_count >= settings.TSA_QUORUM,
        }
        self.stdout.write(json.dumps(summary, ensure_ascii=False))
