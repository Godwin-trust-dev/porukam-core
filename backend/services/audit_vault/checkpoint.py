"""Ежесуточный checkpoint цепочки (tech-spec.md §10.3, ADR-038, ADR-135):
якорь на конец текущей цепочки (`this_hash` последней записи уже покрывает
всё предыдущее содержание), корень штампуется у TSA (кворум, nonce) и
выгружается в WORM-объект вместе с содержимым диапазона. Идемпотентен:
повторный запуск в тот же день без новых записей (`seq_from > seq_to`)
ничего не делает и не создаёт дублирующий AuditCheckpoint (см. также
unique_audit_checkpoint_seq_to).

Формат записи чекпойнта (WORM-объект; в БД — те же поля, кроме `leaves`,
листья там и так лежат как AuditEntry):

    {"format": "porukam.audit_checkpoint/2",
     "alg": "sha256",                       # п.5 ADR-135 — поле, не константа
     "root": "<hex this_hash seq_to>",
     "seq_from": .., "seq_to": ..,
     "host_id": "<HOST_ID из env>",         # п.7 — не hostname
     "created_at": "...",
     "leaves": {"kind": "audit_entry_chain",
                "entries": [{"seq", "canonical", "this_hash"}, ...]},   # п.6
     "tsa_status": "attested|unattested|fake",                          # п.2
     "timestamps": [{"tsa", "alg", "nonce", "tsq_b64", "tsr_b64",       # п.3
                     "gen_time", "serial", "policy", "signer",
                     "chain_pem": [...], "chain_complete",
                     "revocation": {"kind": "ocsp|crl", ...} | null, ...}, ...],
     "tsa_failures": [{"tsa", "error"}, ...]}

`timestamps` — список: несколько слоёв меток на один чекпойнт (rollover
в будущем — новые слои дописываются, старые не трогаются)."""

from __future__ import annotations

import base64
import json
import logging
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

import structlog
from django.conf import settings
from django.utils import timezone

from . import tsa
from .canonical import canonical_bytes
from .models import AuditCheckpoint, AuditEntry
from .providers import STATUS_ATTESTED, STATUS_UNATTESTED, TimestampAuthority
from .storage import CheckpointObjectStore

logger = logging.getLogger(__name__)
event_log = structlog.get_logger(__name__)

CHECKPOINT_FORMAT = "porukam.audit_checkpoint/2"
CHECKPOINT_ALG = "sha256"  # алгоритм хеш-цепочки (canonical.compute_hash)

EVENT_CHECKPOINT_UNATTESTED = "audit_vault.checkpoint_unattested"


def _leaves(seq_from: int, seq_to: int) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    queryset = AuditEntry.objects.filter(seq__gte=seq_from, seq__lte=seq_to).order_by("seq")
    for entry in queryset.iterator(chunk_size=500):
        canonical = canonical_bytes(
            seq=entry.seq,
            actor=entry.actor,
            actor_role=entry.actor_role,
            action=entry.action,
            target_type=entry.target_type,
            target_id=entry.target_id,
            payload=entry.payload,
            at=entry.at,
            prev_hash=entry.prev_hash,
        )
        entries.append(
            {"seq": entry.seq, "canonical": canonical.decode("ascii"), "this_hash": entry.this_hash}
        )
    return entries


def compute_daily_checkpoint(
    *, provider: TimestampAuthority, store: CheckpointObjectStore
) -> AuditCheckpoint | None:
    latest_entry = AuditEntry.objects.order_by("-seq").first()
    if latest_entry is None:
        return None

    last_checkpoint = AuditCheckpoint.objects.order_by("-seq_to").first()
    seq_from = (last_checkpoint.seq_to + 1) if last_checkpoint is not None else 1
    seq_to = latest_entry.seq
    if seq_from > seq_to:
        return None

    digest = latest_entry.this_hash
    host_id: str = settings.HOST_ID
    if not host_id:
        logger.warning("checkpoint: HOST_ID не задан — запись чекпойнта без идентификатора хоста")

    outcome = provider.stamp(digest, alg=CHECKPOINT_ALG)
    if outcome.status == STATUS_UNATTESTED:
        # ADR-135 п.4: недобор кворума — ошибка, а не «нет данных».
        event_log.error(
            EVENT_CHECKPOINT_UNATTESTED,
            seq_from=seq_from,
            seq_to=seq_to,
            root=digest,
            attested=len(outcome.timestamps),
            quorum=getattr(provider, "quorum", None),
            failures=outcome.failures,
        )

    created_at = timezone.now()
    object_key = f"checkpoints/{seq_from:012d}-{seq_to:012d}.json"
    record = {
        "format": CHECKPOINT_FORMAT,
        "alg": CHECKPOINT_ALG,
        "root": digest,
        "seq_from": seq_from,
        "seq_to": seq_to,
        "host_id": host_id or None,
        "created_at": created_at.isoformat(),
        "leaves": {"kind": "audit_entry_chain", "entries": _leaves(seq_from, seq_to)},
        "tsa_status": outcome.status,
        "timestamps": outcome.timestamps,
        "tsa_failures": outcome.failures,
    }
    body = json.dumps(record, sort_keys=True, ensure_ascii=True).encode("utf-8")
    retention_days = settings.AUDIT_VAULT_CHECKPOINT_RETENTION_DAYS
    store.put_worm(object_key, body, retain_until=created_at + timedelta(days=retention_days))

    return AuditCheckpoint.objects.create(
        seq_from=seq_from,
        seq_to=seq_to,
        digest=digest,
        alg=CHECKPOINT_ALG,
        host_id=host_id,
        tsa_status=outcome.status,
        timestamps=outcome.timestamps,
        tsa_failures=outcome.failures,
        object_key=object_key,
    )


# ---------------------------------------------------------------------------
# Офлайн-проверка меток чекпойнта (экспорт-пакет юристу, README сервиса)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class TimestampCheck:
    tsa: str
    ok: bool
    errors: tuple[str, ...]
    gen_time: str | None
    signer: str | None


@dataclass(frozen=True, slots=True)
class CheckpointTimestampVerification:
    ok: bool  # число валидных меток >= кворума
    valid: int
    quorum: int
    checks: tuple[TimestampCheck, ...]


def verify_timestamp_record(record: dict[str, Any], *, root: str, alg: str) -> TimestampCheck:
    """Одна метка: `.tsr` против сохранённой цепочки (`chain_pem`) — без сети."""
    tsr_b64 = record.get("tsr_b64")
    tsa_url = str(record.get("tsa", "?"))
    if not tsr_b64:
        return TimestampCheck(tsa_url, False, ("нет .tsr (фейковая метка)",), None, None)
    try:
        chain = tsa.certificates_from_pem(list(record.get("chain_pem") or []))
        nonce_text = record.get("nonce")
        nonce = int(str(nonce_text), 16) if nonce_text else None
        verification = tsa.verify_timestamp_token(
            base64.b64decode(tsr_b64),
            message_imprint=bytes.fromhex(root),
            alg=alg,
            nonce=nonce,
            extra_certificates=chain,
        )
    except (tsa.TsaError, ValueError) as exc:
        return TimestampCheck(tsa_url, False, (str(exc),), None, None)
    errors = list(verification.errors)
    if chain:
        chain_ok, chain_errors = tsa.verify_chain_links(chain)
        if not chain_ok:
            errors.extend(chain_errors)
        if (
            verification.signer_certificate is not None
            and chain[0] != verification.signer_certificate
        ):
            errors.append("первый сертификат архивной цепочки — не подписант токена")
    else:
        errors.append("архивная цепочка сертификатов отсутствует")
    info = verification.response.tst_info
    return TimestampCheck(
        tsa=tsa_url,
        ok=not errors,
        errors=tuple(errors),
        gen_time=info.gen_time.isoformat() if info is not None else None,
        signer=(
            verification.signer_certificate.subject.rfc4514_string()
            if verification.signer_certificate is not None
            else None
        ),
    )


def verify_checkpoint_timestamps(
    checkpoint: AuditCheckpoint, *, quorum: int | None = None
) -> CheckpointTimestampVerification:
    quorum = settings.TSA_QUORUM if quorum is None else quorum
    checks = tuple(
        verify_timestamp_record(record, root=checkpoint.digest, alg=checkpoint.alg)
        for record in checkpoint.timestamps
    )
    valid = sum(1 for check in checks if check.ok)
    return CheckpointTimestampVerification(
        ok=valid >= quorum and checkpoint.tsa_status == STATUS_ATTESTED,
        valid=valid,
        quorum=quorum,
        checks=checks,
    )
