"""Read-слой apps.archive (ADR-139): запись сделки для манифеста и превью
состава — композиция ТОЛЬКО поверх фасадов/селекторов других приложений
(как apps.dashboards, ADR-090): contracts, profiles, milestones, payments,
disputes, warranty, evidence + Audit Vault через `apps.audit.client`."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from django.conf import settings
from django.db.models import QuerySet
from django.shortcuts import get_object_or_404

from apps.accounts.models import User
from apps.audit import client as audit_client
from apps.contracts import selectors as contracts_selectors
from apps.contracts.models import Contract
from apps.disputes import selectors as disputes_selectors
from apps.evidence import selectors as evidence_selectors
from apps.evidence import services as evidence_services
from apps.evidence.models import Evidence
from apps.milestones import selectors as milestones_selectors
from apps.milestones import services as milestones_services
from apps.payments import selectors as payments_selectors
from apps.profiles import selectors as profiles_selectors
from apps.warranty import selectors as warranty_selectors

from . import package
from .models import ArchiveExport, ArchiveLink

EVIDENCE_RECEIVED_ACTION = "evidence.received"
EVIDENCE_TARGET_TYPE = "evidence"

_ENDED_STATUSES = frozenset(
    {
        Contract.ExecutionStatus.COMPLETED,
        Contract.ExecutionStatus.WARRANTY,
        Contract.ExecutionStatus.CLOSED,
        Contract.ExecutionStatus.TERMINATED_BY_CUSTOMER,
        Contract.ExecutionStatus.TERMINATED_BY_CONTRACTOR,
    }
)
_TERMINATED_STATUSES = frozenset(
    {
        Contract.ExecutionStatus.TERMINATED_BY_CUSTOMER,
        Contract.ExecutionStatus.TERMINATED_BY_CONTRACTOR,
    }
)


def get_export_or_404(contract: Contract, export_id: UUID) -> ArchiveExport:
    return get_object_or_404(ArchiveExport, pk=export_id, contract=contract)


def get_link_or_404(link_id: UUID) -> ArchiveLink:
    return get_object_or_404(ArchiveLink.objects.select_related("export__contract"), pk=link_id)


def list_exports(contract: Contract) -> QuerySet[ArchiveExport]:
    return ArchiveExport.objects.filter(contract=contract).order_by("-created_at")


def find_active_export(
    contract: Contract, *, include_originals: bool, manifest_only: bool
) -> ArchiveExport | None:
    """Идущая сборка с теми же опциями — повторный POST возвращает её
    (идемпотентность поверх Idempotency-Key: другой ключ, тот же смысл)."""
    return (
        ArchiveExport.objects.filter(
            contract=contract,
            include_originals=include_originals,
            manifest_only=manifest_only,
            status__in=[ArchiveExport.Status.QUEUED, ArchiveExport.Status.RUNNING],
        )
        .order_by("created_at")
        .first()
    )


def contract_number(contract: Contract) -> str:
    """Тот же презентационный номер, что в уведомлениях
    (apps.notifications.services._contract_short_number): хвост uuid7."""
    return "№ " + str(contract.id).replace("-", "")[-6:].upper()


def is_ended(contract: Contract) -> bool:
    return contract.execution_status in _ENDED_STATUSES


def contract_status_label(contract: Contract) -> str:
    """`in_work | closed | terminated` — модель DEV-12 (`ArchivePreview.contract_status`)."""
    if contract.execution_status in _TERMINATED_STATUSES:
        return "terminated"
    if contract.execution_status in _ENDED_STATUSES:
        return "closed"
    return "in_work"


def can_export(contract: Contract) -> bool:
    """Есть что собирать: договор хотя бы раз заморожен (черновик без версий
    — «пока нечего собирать», DEV-12 §4)."""
    return contract.versions.exists()


# --- запись сделки --------------------------------------------------------------


def _party_record(party: Any) -> dict[str, Any]:  # noqa: ANN401
    user = contracts_selectors.party_user(party)
    return {
        "profile_id": str(party.profile_id),
        "acting_as": party.acting_as,
        "entity_id": str(party.entity_id) if party.entity_id else None,
        "display_name": profiles_selectors.public_display_name(party.profile),
        "user_id": str(user.id) if user is not None else None,
        "trust_id": user.trust_id if user is not None else None,
    }


def _version_record(version: Any, *, full: bool) -> dict[str, Any]:  # noqa: ANN401
    record: dict[str, Any] = {
        "id": str(version.id),
        "integrity_hash": version.integrity_hash,
        "hash_algorithm": version.hash_algorithm,
        "frozen_at": version.frozen_at.isoformat(),
        "trusted_timestamp_at": version.trusted_timestamp_at.isoformat(),
        "trusted_timestamp_source": version.trusted_timestamp_source,
        "official_language": version.canonical_language,
    }
    if full:
        record["snapshot"] = version.snapshot
    return record


def _signature_record(signature: Any) -> dict[str, Any]:  # noqa: ANN401
    return {
        "side": signature.side,
        "version_hash": signature.version_hash,
        "signed_at": signature.signed_at.isoformat(),
        "signatory_user_id": str(signature.signatory_id),
        "signature_basis": signature.signature_basis,
        "entity_snapshot": signature.entity_snapshot,
    }


def _contract_record(contract: Contract, *, snapshot_at: datetime) -> dict[str, Any]:
    parties = {p.role: _party_record(p) for p in contracts_selectors.list_parties(contract)}
    versions = list(contract.versions.filter(frozen_at__lte=snapshot_at).order_by("frozen_at"))
    frozen = contract.frozen_version
    try:
        total = milestones_services.total_leaf_amount(contract)
        total_record: dict[str, str] | None = {
            "amount": str(total.amount),
            "currency": total.currency,
        }
    except ValueError:
        total_record = None
    return {
        "id": str(contract.id),
        "number": contract_number(contract),
        "title": contract.title,
        "contract_type_code": contract.contract_type_id,
        "deal_type": contract.deal_type,
        "segment": contract.segment,
        "jurisdiction": contract.jurisdiction,
        "negotiation_status": contract.negotiation_status,
        "execution_status": contract.execution_status,
        "payment_method": contract.payment_method,
        # ADR-151: порядок оплаты этапа (`null` — не выбран / неприменим).
        "payment_order": contract.payment_order,
        "protected": contract.protected,
        "created_at": contract.created_at.isoformat(),
        "parties": parties,
        "total": total_record,
        "frozen_version": _version_record(frozen, full=True) if frozen is not None else None,
        "versions": [_version_record(v, full=False) for v in versions],
        "signatures": [
            _signature_record(s)
            for s in contract.signatures.filter(
                amendment__isnull=True, signed_at__lte=snapshot_at
            ).order_by("side")
        ],
        "additional_terms": list(contract.additional_terms or []),
    }


def _amendment_records(contract: Contract, *, snapshot_at: datetime) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for amendment in contracts_selectors.list_amendments(contract):
        if amendment.created_at > snapshot_at:
            continue
        records.append(
            {
                "id": str(amendment.id),
                "order": amendment.order,
                "reason": amendment.reason,
                "custom_terms": amendment.custom_terms,
                "negotiation_status": amendment.negotiation_status,
                "frozen_version_hash": (
                    amendment.frozen_version.integrity_hash if amendment.frozen_version else None
                ),
                "created_at": amendment.created_at.isoformat(),
                "changes": [
                    {
                        "type": change.type,
                        "target_id": str(change.target) if change.target else None,
                        "payload": change.payload,
                    }
                    for change in contracts_selectors.list_amendment_changes(amendment)
                ],
                "signatures": [
                    _signature_record(s)
                    for s in amendment.signatures.filter(signed_at__lte=snapshot_at).order_by(
                        "side"
                    )
                ],
            }
        )
    return records


def _json_safe(value: Any) -> Any:  # noqa: ANN401
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_json_safe(v) for v in value]
    return value


def _milestone_records(contract: Contract) -> list[dict[str, Any]]:
    tree = milestones_selectors.build_tree(contract)

    def _enrich(node: dict[str, Any]) -> dict[str, Any]:
        milestone = milestones_selectors.get_milestone_or_404(UUID(node["id"]))
        node["checklist"] = [
            {
                "id": str(item.id),
                "description": item.description,
                "measurable_criterion": item.measurable_criterion,
                "required_evidence": item.required_evidence,
            }
            for item in milestones_selectors.list_checklist_items(milestone)
        ]
        node["materials"] = [
            {
                "id": str(m.id),
                "description": m.description,
                "quantity": str(m.quantity),
                "unit": m.unit,
                "unit_price": str(m.unit_price),
                "currency": m.unit_price_currency,
                "source": m.source,
                "received": m.received,
            }
            for m in milestones_selectors.list_materials(milestone)
        ]
        node["children"] = [_enrich(child) for child in node["children"]]
        return _json_safe(node)  # type: ignore[no-any-return]

    return [_enrich(root) for root in tree]


def _payment_records(contract: Contract) -> list[dict[str, Any]]:
    return [
        _json_safe(payments_selectors.payment_view(payment))
        for payment in payments_selectors.list_for_contract(contract)
    ]


def _dispute_records(contract: Contract, *, snapshot_at: datetime) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for dispute in disputes_selectors.list_for_contract(contract.id):
        if dispute.opened_at > snapshot_at:
            continue
        records.append(
            {
                "id": str(dispute.id),
                "kind": dispute.kind,
                "milestone_id": str(dispute.milestone_id) if dispute.milestone_id else None,
                "status": dispute.status,
                "outcome": dispute.outcome,
                "resolution_type": dispute.resolution_type,
                "fix_rounds_used": dispute.fix_rounds_used,
                "opened_at": dispute.opened_at.isoformat(),
                "resolved_at": dispute.resolved_at.isoformat() if dispute.resolved_at else None,
            }
        )
    return records


def _warranty_records(contract: Contract) -> list[dict[str, Any]]:
    return [
        {
            "id": str(claim.id),
            "status": claim.status,
            "dispute_id": str(claim.dispute_id) if claim.dispute_id else None,
            "resolution_type": claim.resolution_type,
            "submitted_at": claim.submitted_at.isoformat(),
            "resolved_at": claim.resolved_at.isoformat() if claim.resolved_at else None,
        }
        for claim in warranty_selectors.list_for_contract(contract)
    ]


def _official_locale(contract: Contract) -> str:
    """Язык подписей хроники в пакете (ADR-134: `kind`/`title` отдаёт
    read-модель) — официальный язык договора (`canonical_language` последней
    замороженной версии); до заморозки — en."""
    version = contract.versions.order_by("-frozen_at").first()
    return str(version.canonical_language) if version is not None else "en"


def _timeline_records(contract: Contract, *, snapshot_at: datetime) -> list[dict[str, Any]]:
    entries = contracts_selectors.get_timeline(contract, locale=_official_locale(contract))
    return [
        {
            "event_id": str(entry.event_id),
            "topic": entry.topic,
            "kind": entry.kind,
            "title": entry.title,
            "occurred_at": entry.occurred_at.isoformat(),
            "actor": entry.actor,
            "payload": entry.payload,
        }
        for entry in entries
        if entry.occurred_at <= snapshot_at
    ]


# --- доказательства и цепочный путь ------------------------------------------


def _evidence_record(
    evidence: Evidence, *, included: bool, thumbnail_included: bool
) -> dict[str, Any]:
    return {
        "id": str(evidence.id),
        "path": package.evidence_file_path(str(evidence.id), evidence.file_name),
        "thumbnail_path": package.thumbnail_path(str(evidence.id)) if thumbnail_included else None,
        "original_included": included,
        "file_name": evidence.file_name,
        # Пояснение автора, данное при загрузке (решение владельца 05.09).
        # В архив идёт вместе с файлом: подпись «что тут снято» бесполезна,
        # если пропадает ровно там, где выгрузку читает третья сторона.
        "description": evidence.description,
        "mime_type": evidence.mime_type,
        "file_size": evidence.file_size,
        "sha256": evidence.file_hash,
        "trusted_timestamp_at": evidence.trusted_timestamp_at.isoformat(),
        "trusted_timestamp_source": evidence.trusted_timestamp_source,
        "uploaded_by_user_id": str(evidence.uploaded_by_id),
        "milestone_id": str(evidence.milestone_id) if evidence.milestone_id else None,
        "checklist_item_id": str(evidence.checklist_item_id)
        if evidence.checklist_item_id
        else None,
        "dispute_id": str(evidence.dispute_id) if evidence.dispute_id else None,
        "captured_at_device": (
            evidence.captured_at_device.isoformat() if evidence.captured_at_device else None
        ),
        "device_clock_skew_ms": evidence.device_clock_skew_ms,
        "device_key_id": evidence.device_key_id,
        "assignment_id": str(evidence.assignment_id) if evidence.assignment_id else None,
        "lateness": evidence.lateness,
        "strong_protection": evidence_services.is_strongly_protected(evidence),
        "has_geo": evidence.geo_encrypted is not None,
        "retention_state": evidence.retention_state,
        "metadata": evidence.metadata,
        "audit": None,
    }


def _belongs_to_contract(entry: Any, *, contract_id: str, evidence_ids: set[str]) -> bool:  # noqa: ANN401
    """Раскрывать canonical только записей ЭТОЙ сделки: цель — договор либо
    его доказательство, либо payload/subject несёт наш contract_id."""
    if entry.target_type == "contract" and entry.target_id == contract_id:
        return True
    if entry.target_type == EVIDENCE_TARGET_TYPE and entry.target_id in evidence_ids:
        return True
    payload = entry.payload or {}
    return str(payload.get("contract_id") or "") == contract_id


def build_audit_proofs(
    contract: Contract, evidence_items: list[Evidence]
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    """Для каждого доказательства — seq записи `evidence.received`, чекпойнт
    и ссылка на цепочный путь; пути группируются по чекпойнту (один путь
    от САМОЙ РАННЕЙ нашей записи до корня покрывает все доказательства
    этого чекпойнта). Возвращает (audit по evidence_id, чекпойнты, chains)."""
    contract_id = str(contract.id)
    evidence_ids = {str(e.id) for e in evidence_items}
    per_evidence: dict[str, Any] = {}
    checkpoints: dict[int, audit_client.CheckpointInfo] = {}
    first_seq_by_checkpoint: dict[int, int] = {}
    for evidence in evidence_items:
        seq = audit_client.find_entry_seq(
            action=EVIDENCE_RECEIVED_ACTION,
            target_type=EVIDENCE_TARGET_TYPE,
            target_id=str(evidence.id),
        )
        if seq is None:
            per_evidence[str(evidence.id)] = {
                "entry_seq": None,
                "checkpoint_id": None,
                "chain_ref": None,
                "note": "audit_entry_missing",
            }
            continue
        info = audit_client.checkpoint_covering(seq)
        if info is not None:
            checkpoints[info.id] = info
            first_seq_by_checkpoint[info.id] = min(first_seq_by_checkpoint.get(info.id, seq), seq)
        per_evidence[str(evidence.id)] = {
            "entry_seq": seq,
            "checkpoint_id": info.id if info is not None else None,
            "chain_ref": f"checkpoint-{info.id}" if info is not None else None,
            "note": None if info is not None else "checkpoint_pending",
        }

    chains: dict[str, Any] = {}
    max_links = settings.ARCHIVE_CHAIN_PATH_MAX_LINKS
    for checkpoint_id, info in sorted(checkpoints.items()):
        links, truncated = audit_client.chain_links(
            seq_from=first_seq_by_checkpoint[checkpoint_id],
            seq_to=info.seq_to,
            disclose=lambda entry: _belongs_to_contract(
                entry, contract_id=contract_id, evidence_ids=evidence_ids
            ),
            max_links=max_links,
        )
        chains[f"checkpoint-{checkpoint_id}"] = {
            "kind": "linear_hash_chain",
            "hash": "this_hash = sha256(prev_hash || canonical)",
            "checkpoint_id": checkpoint_id,
            "root": info.root,
            "alg": info.alg,
            "tsa_status": info.tsa_status,
            "seq_from": first_seq_by_checkpoint[checkpoint_id],
            "seq_to": info.seq_to,
            "truncated": truncated,
            "links": [
                {
                    "seq": link.seq,
                    "prev_hash": link.prev_hash,
                    "this_hash": link.this_hash,
                    "action": link.action if link.canonical is not None else None,
                    "at": link.at if link.canonical is not None else None,
                    "canonical": link.canonical,
                }
                for link in links
            ],
        }
    checkpoint_records = []
    for checkpoint_id, info in sorted(checkpoints.items()):
        record = audit_client.checkpoint_record(info)
        record["files_dir"] = f"checkpoint-{checkpoint_id}"
        record["openssl"] = audit_client.checkpoint_openssl_commands(
            info, directory=f"checkpoint-{checkpoint_id}"
        )
        checkpoint_records.append(record)
    return per_evidence, checkpoint_records, chains


def collect_record(
    export: ArchiveExport,
    *,
    evidence_items: list[Evidence],
    included_ids: set[str],
    thumbnail_ids: set[str],
) -> tuple[dict[str, Any], list[audit_client.CheckpointInfo]]:
    """Полная запись сделки для manifest.json. Единственное время — snapshot_at."""
    contract = export.contract
    snapshot_at = export.snapshot_at
    audit_by_evidence, checkpoint_records, chains = build_audit_proofs(contract, evidence_items)
    evidence_records = []
    for evidence in evidence_items:
        record = _evidence_record(
            evidence,
            included=str(evidence.id) in included_ids,
            thumbnail_included=str(evidence.id) in thumbnail_ids,
        )
        record["audit"] = audit_by_evidence.get(str(evidence.id))
        evidence_records.append(record)
    timeline = _timeline_records(contract, snapshot_at=snapshot_at)
    milestones = _milestone_records(contract)
    payments = _payment_records(contract)
    disputes = _dispute_records(contract, snapshot_at=snapshot_at)
    record = {
        "format": package.MANIFEST_FORMAT,
        "generator": "porukam.archive",
        "export": {
            "id": str(export.id),
            "contract_id": str(contract.id),
            "trigger": export.trigger,
            "snapshot_at": snapshot_at.isoformat(),
            "is_snapshot": export.is_snapshot,
            "include_originals": export.include_originals,
            "manifest_only": export.manifest_only,
        },
        "contract": _contract_record(contract, snapshot_at=snapshot_at),
        "amendments": _amendment_records(contract, snapshot_at=snapshot_at),
        "milestones": milestones,
        "payments": payments,
        "disputes": disputes,
        "warranty_claims": _warranty_records(contract),
        "timeline": timeline,
        "evidence": evidence_records,
        "audit_checkpoints": checkpoint_records,
        "audit_chains": chains,
        "retention": {
            **evidence_selectors.retention_summary(contract.id),
            "policy": evidence_selectors.retention_policy(),
        },
        "sections": {
            "contract": {"count": len(contract.versions.all()), "complete": is_ended(contract)},
            "milestones": {"count": _count_nodes(milestones), "complete": is_ended(contract)},
            "events": {"count": len(timeline), "complete": is_ended(contract)},
            "evidence": {
                "count": len(evidence_records),
                "size_bytes": sum(e.file_size for e in evidence_items),
                "complete": is_ended(contract),
            },
            "payments": {"count": len(payments), "complete": is_ended(contract)},
            "dispute": {
                "count": len(disputes),
                "complete": not disputes_selectors.has_open_disputes(contract.id),
            },
        },
    }
    infos = [
        info
        for info in (audit_client.checkpoint_covering(c["seq_from"]) for c in checkpoint_records)
        if info is not None
    ]
    return record, infos


def _count_nodes(nodes: list[dict[str, Any]]) -> int:
    return sum(1 + _count_nodes(node.get("children", [])) for node in nodes)


# --- превью (GET /contracts/{id}/archive) ------------------------------------


def preview(contract: Contract, *, user: User) -> dict[str, Any]:
    """`ArchivePreview` DEV-12 §2 + список экспортов. Симметрия: обе стороны
    видят один и тот же состав; `counterparty` — относительно вызывающего."""
    evidence_items = list(evidence_selectors.list_for_contract(contract.id))
    ended = is_ended(contract)
    tree = milestones_selectors.build_tree(contract)
    accepted = _count_accepted(tree)
    total = _count_nodes(tree)
    events_count = len(
        contracts_selectors.get_timeline(contract, locale=_official_locale(contract))
    )
    payments_count = payments_selectors.list_for_contract(contract).count()
    disputes_count = disputes_selectors.list_for_contract(contract.id).count()
    evidence_size = sum(e.file_size for e in evidence_items)
    try:
        other = contracts_selectors.resolve_counterparty(contract, user)
        counterparty = profiles_selectors.public_display_name(other.profile) or ""
    except contracts_selectors.PartyNotFoundError:
        counterparty = ""
    sections = [
        {
            "key": "contract",
            "count": contract.versions.count(),
            "size_bytes": None,
            "complete": contract.negotiation_status == Contract.NegotiationStatus.SIGNED,
        },
        {
            "key": "milestones",
            "count": total,
            "size_bytes": None,
            "complete": ended or accepted == total,
        },
        {"key": "events", "count": events_count, "size_bytes": None, "complete": ended},
        {
            "key": "evidence",
            "count": len(evidence_items),
            "size_bytes": evidence_size,
            "complete": ended,
        },
        {"key": "payments", "count": payments_count, "size_bytes": None, "complete": ended},
    ]
    if disputes_count:
        sections.append(
            {
                "key": "dispute",
                "count": disputes_count,
                "size_bytes": None,
                "complete": not disputes_selectors.has_open_disputes(contract.id),
            }
        )
    return {
        "contract_id": str(contract.id),
        "contract_no": contract_number(contract),
        "counterparty": counterparty,
        "contract_status": contract_status_label(contract),
        "is_snapshot": not ended,
        "sections": sections,
        "format": {"pdf": False, "zip": True, "html": True},
        "est_size_bytes": evidence_size,
        "drive_backup": "off",
        "can_export": can_export(contract),
        "retention": evidence_selectors.retention_summary(contract.id),
    }


def _count_accepted(nodes: list[dict[str, Any]]) -> int:
    return sum(
        (1 if node.get("status") in ("accepted", "paid") else 0)
        + _count_accepted(node.get("children", []))
        for node in nodes
    )
