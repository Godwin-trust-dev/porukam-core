"""Экспорт заверенного чекпойнта в файлы для внешней проверки (ADR-135,
ADR-139): `checkpoint-<id>.json` (запись чекпойнта без листьев) + на каждую
метку RFC 3161 — `NN-<host>.tsq`, `NN-<host>.tsr`, `NN-<host>.chain.pem`,
`NN-<host>.<ocsp|crl>.der`.

ЕДИНСТВЕННАЯ реализация набора файлов метки (`checkpoint_files`) — её
используют и management-команда `verify_checkpoint_timestamps --export-dir`
(через `export_checkpoint_to_dir`), и доказательный пакет сделки
(`apps.archive` через фасад `apps.audit.client`): пакет юристу и пакет сделки
обязаны проверяться одними и теми же командами `openssl ts -verify`.

Чистые функции над `CheckpointInfo` (services/audit_vault/api.py) — без
Django-моделей: вызывающая сторона (apps.archive) читает Vault только через
фасад apps.audit.client; команда получает `CheckpointInfo` через
`api.checkpoint_info(checkpoint)`."""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .api import CheckpointInfo

CHECKPOINT_EXPORT_FORMAT = "porukam.archive_checkpoint/1"


def checkpoint_record(info: CheckpointInfo) -> dict[str, Any]:
    """Запись чекпойнта для `checkpoint-<id>.json` пакета: корень, диапазон,
    алгоритм (поле, не константа — ADR-135 п.5), статус кворума и метки
    (без листьев: они — `chain_path` манифеста, только записи этой сделки)."""
    return {
        "format": CHECKPOINT_EXPORT_FORMAT,
        "checkpoint_id": info.id,
        "alg": info.alg,
        "root": info.root,
        "seq_from": info.seq_from,
        "seq_to": info.seq_to,
        "host_id": info.host_id or None,
        "created_at": info.created_at,
        "tsa_status": info.tsa_status,
        "object_key": info.object_key,
        "timestamps": [
            {
                key: record.get(key)
                for key in (
                    "tsa",
                    "alg",
                    "nonce",
                    "gen_time",
                    "serial",
                    "policy",
                    "signer",
                    "chain_complete",
                    "requested_at",
                    "warnings",
                )
            }
            for record in info.timestamps
        ],
    }


def timestamp_stem(index: int, record: dict[str, Any]) -> str:
    host = urlsplit(str(record.get("tsa", ""))).hostname or f"tsa{index}"
    return f"{index:02d}-{host}"


def checkpoint_files(info: CheckpointInfo) -> list[tuple[str, bytes]]:
    """Файлы меток чекпойнта: (имя, байты) на каждую метку с `.tsr`.
    Фейковая метка (dev/test, `tsa_token` без `.tsr`) файлов не даёт —
    честно: проверять `openssl ts -verify` там нечего."""
    files: list[tuple[str, bytes]] = []
    for index, record in enumerate(info.timestamps):
        if not record.get("tsr_b64"):
            continue
        stem = timestamp_stem(index, record)
        if record.get("tsq_b64"):
            files.append((f"{stem}.tsq", base64.b64decode(record["tsq_b64"])))
        files.append((f"{stem}.tsr", base64.b64decode(record["tsr_b64"])))
        chain_pem = "".join(record.get("chain_pem") or [])
        if chain_pem:
            files.append((f"{stem}.chain.pem", chain_pem.encode("ascii")))
        revocation = record.get("revocation")
        if revocation and revocation.get("der_b64"):
            files.append(
                (f"{stem}.{revocation['kind']}.der", base64.b64decode(revocation["der_b64"]))
            )
    return files


def openssl_commands(info: CheckpointInfo, *, directory: str) -> list[str]:
    """Готовые команды проверки для README пакета (одна на метку).
    `directory` — подкаталог внутри пакета; пустая строка — файлы лежат
    рядом с README (экспорт management-команды в каталог)."""
    commands: list[str] = []
    prefix = f"{directory}/" if directory else ""
    for index, record in enumerate(info.timestamps):
        if not record.get("tsr_b64"):
            continue
        stem = f"{prefix}{timestamp_stem(index, record)}"
        if record.get("tsq_b64"):
            commands.append(
                f"openssl ts -verify -queryfile {stem}.tsq -in {stem}.tsr "
                f"-CAfile {stem}.chain.pem -untrusted {stem}.chain.pem"
            )
        else:
            commands.append(
                f"openssl ts -verify -digest {info.root} -in {stem}.tsr -CAfile {stem}.chain.pem"
            )
    return commands


def checkpoint_text(info: CheckpointInfo) -> str:
    """`checkpoint.txt` каталога экспорта: корень, диапазон, статус и на
    каждую метку — источник, genTime, подписант и готовая команда проверки
    (файлы лежат в том же каталоге)."""
    lines = [
        f"checkpoint id={info.id} seq=[{info.seq_from}, {info.seq_to}]",
        f"alg={info.alg} root={info.root}",
        f"host_id={info.host_id or '-'} tsa_status={info.tsa_status}",
        "",
    ]
    commands = openssl_commands(info, directory="")
    attested = [record for record in info.timestamps if record.get("tsr_b64")]
    for record, command in zip(attested, commands, strict=True):
        lines += [
            f"# {record.get('tsa')} genTime={record.get('gen_time')} signer={record.get('signer')}",
            command,
            "",
        ]
    return "\n".join(lines)


def export_checkpoint_to_dir(info: CheckpointInfo, directory: Path) -> list[Path]:
    """Экспорт для `verify_checkpoint_timestamps --export-dir`: файлы меток
    (`checkpoint_files`) + `checkpoint.txt`. Возвращает записанные пути."""
    directory.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for name, body in checkpoint_files(info):
        path = directory / name
        path.write_bytes(body)
        written.append(path)
    readme = directory / "checkpoint.txt"
    readme.write_text(checkpoint_text(info), encoding="utf-8")
    written.append(readme)
    return written
