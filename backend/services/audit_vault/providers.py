"""TimestampAuthority (tech-spec.md §9.1, RFC 3161) — Vault штампует корень
ежесуточного checkpoint'а у TSA, доказывая нередактируемость цепочки во
времени (ADR-038). ADR-135: реальный клиент — `Rfc3161TimestampAuthority`,
параллельно к нескольким независимым публичным TSA с кворумом (2 из 4) и
обязательным nonce; `FakeTimestampAuthority` — детерминированный фейк для
dev/test (сеть в тестах запрещена).

Выбор — `default_timestamp_authority()` по `settings.AUDIT_VAULT_TSA_PROVIDER`
(`fake` | `rfc3161`), тот же приём, что NOTIFICATIONS_*_PROVIDER /
EVIDENCE_DRIVE_PROVIDER."""

from __future__ import annotations

import hashlib
import logging
import secrets
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from concurrent.futures import TimeoutError as FutureTimeoutError
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol
from urllib.parse import urlsplit

import httpx
from django.conf import settings
from django.utils import timezone

from common import circuit

from . import tsa

logger = logging.getLogger(__name__)

STATUS_ATTESTED = "attested"
STATUS_UNATTESTED = "unattested"
STATUS_FAKE = "fake"

USER_AGENT = "porukam-audit-vault/1 (RFC 3161 client)"


@dataclass(frozen=True, slots=True)
class StampOutcome:
    """Результат штампования одного корня: `timestamps` — успешные слои
    (по одному на TSA; формат допускает несколько слоёв на один чекпойнт —
    rollover), `failures` — отвергнутые/недоступные TSA, `status` —
    семантика кворума (ADR-135 п.2)."""

    status: str
    timestamps: list[dict[str, Any]]
    failures: list[dict[str, Any]] = field(default_factory=list)

    @property
    def attested(self) -> bool:
        return self.status == STATUS_ATTESTED


class TimestampAuthority(Protocol):
    provider_code: str

    def stamp(self, digest: str, *, alg: str = "sha256") -> StampOutcome: ...


class FakeTimestampAuthority:
    """Полностью детерминированный фейк: `serial` — хеш от (digest, момент
    штампа), без реальной криптографии RFC 3161; статус — `fake`, чтобы
    метрики/алерты не принимали его за заверенный чекпойнт."""

    provider_code = "tsa_fake"

    def stamp(self, digest: str, *, alg: str = "sha256") -> StampOutcome:
        stamped_at = timezone.now()
        serial = hashlib.sha256(f"{digest}|{stamped_at.isoformat()}".encode("ascii")).hexdigest()
        circuit.record_success(self.provider_code)
        return StampOutcome(
            status=STATUS_FAKE,
            timestamps=[
                {
                    "tsa": self.provider_code,
                    "alg": alg,
                    "serial": serial,
                    "gen_time": stamped_at.isoformat(),
                    "tsq_b64": None,
                    "tsr_b64": None,
                    "chain_pem": [],
                    "chain_complete": False,
                    "revocation": None,
                }
            ],
        )


def _default_client_factory(timeout: float) -> Callable[[], httpx.Client]:
    def factory() -> httpx.Client:
        return httpx.Client(
            timeout=timeout, follow_redirects=True, headers={"User-Agent": USER_AGENT}
        )

    return factory


def provider_code_for(url: str) -> str:
    """Ключ circuit-реестра/метрик по хосту TSA: `tsa:tsa.swisssign.net`."""
    return f"tsa:{urlsplit(url).hostname or url}"


class Rfc3161TimestampAuthority:
    """ADR-135: параллельные запросы ко всем `endpoints` (по потоку на
    TSA — сетевой I/O, GIL не мешает; в сервисе принят синхронный httpx),
    каждый со своим криптослучайным nonce и `certReq=true`; ответ
    проверяется офлайн (tsa.verify_timestamp_token) и архивируется вместе с
    цепочкой сертификатов и OCSP/CRL на момент штампования. Кворум —
    `quorum` успешных: меньше → `unattested` (алерт ставит checkpoint.py).

    Общее ожидание ограничено `timeout` + запас: отставший поток дорабатывает
    в фоне (httpx-таймаут гарантирует завершение), в результат не попадает."""

    provider_code = "tsa_rfc3161"

    def __init__(
        self,
        *,
        endpoints: list[str],
        quorum: int,
        timeout: float,
        client_factory: Callable[[], httpx.Client] | None = None,
        now: Callable[[], datetime] = timezone.now,
        archive_pki: bool = True,
    ) -> None:
        if not endpoints:
            raise ValueError("TSA_ENDPOINTS пуст")
        if quorum < 1 or quorum > len(endpoints):
            raise ValueError(f"TSA_QUORUM={quorum} вне [1, {len(endpoints)}]")
        self._endpoints = list(endpoints)
        self._quorum = quorum
        self._timeout = timeout
        self._client_factory = client_factory or _default_client_factory(timeout)
        self._now = now
        self._archive_pki = archive_pki

    @property
    def quorum(self) -> int:
        return self._quorum

    def stamp(self, digest: str, *, alg: str = "sha256") -> StampOutcome:
        message_imprint = bytes.fromhex(digest)
        records: list[tuple[str, tsa.TimestampRecord]] = []
        failures: list[dict[str, Any]] = []
        pool = ThreadPoolExecutor(max_workers=len(self._endpoints), thread_name_prefix="tsa")
        futures = {
            pool.submit(self._stamp_one, url, message_imprint, alg): url for url in self._endpoints
        }
        pending = set(futures)
        try:
            # Запас к таймауту: httpx-таймаут срабатывает на каждой фазе
            # (connect/read) отдельно, суммарно запрос может быть дольше.
            for future in as_completed(futures, timeout=self._timeout * 2 + 5):
                pending.discard(future)
                url = futures[future]
                try:
                    records.append((url, future.result()))
                except tsa.TsaError as exc:
                    failures.append({"tsa": url, "error": str(exc)})
                except Exception as exc:  # noqa: BLE001 — один TSA не должен ронять остальные
                    logger.exception("tsa: непредвиденная ошибка провайдера", extra={"tsa": url})
                    failures.append({"tsa": url, "error": f"{type(exc).__name__}: {exc}"})
        except FutureTimeoutError:
            for future in pending:
                failures.append({"tsa": futures[future], "error": "timeout (общее ожидание)"})
        finally:
            # Не ждём отставшие потоки: httpx-таймаут их всё равно завершит.
            pool.shutdown(wait=False, cancel_futures=True)

        records.sort(key=lambda item: self._endpoints.index(item[0]))
        status = STATUS_ATTESTED if len(records) >= self._quorum else STATUS_UNATTESTED
        return StampOutcome(
            status=status,
            timestamps=[record.as_json() for _, record in records],
            failures=failures,
        )

    def _stamp_one(self, url: str, message_imprint: bytes, alg: str) -> tsa.TimestampRecord:
        code = provider_code_for(url)
        nonce = secrets.randbits(64) | 1  # 64 бита, гарантированно > 0 (ADR-135 п.1)
        try:
            with self._client_factory() as client:
                record = tsa.request_timestamp(
                    url,
                    message_imprint,
                    alg=alg,
                    nonce=nonce,
                    client=client,
                    now=self._now,
                    archive_pki=self._archive_pki,
                )
        except tsa.TsaError as exc:
            circuit.record_failure(code)
            logger.warning("tsa: ответ отвергнут", extra={"tsa": url, "error": str(exc)})
            raise
        except Exception:
            circuit.record_failure(code)
            raise
        circuit.record_success(code)
        logger.info(
            "tsa: метка получена",
            extra={
                "tsa": url,
                "latency_ms": record.latency_ms,
                "gen_time": record.gen_time.isoformat(),
            },
        )
        return record


def default_timestamp_authority() -> TimestampAuthority:
    provider = settings.AUDIT_VAULT_TSA_PROVIDER
    if provider == "rfc3161":
        return Rfc3161TimestampAuthority(
            endpoints=settings.TSA_ENDPOINTS,
            quorum=settings.TSA_QUORUM,
            timeout=settings.TSA_TIMEOUT,
        )
    if provider == "fake":
        return FakeTimestampAuthority()
    raise ValueError(f"AUDIT_VAULT_TSA_PROVIDER={provider!r}: ожидается fake или rfc3161")
