"""Фабрики для тестов apps.archive (не test_*.py). Подписанный договор с
листом, доказательства через apps.evidence.services (фейковый бакет), Vault —
через реле outbox (apps.audit.subscriber), суточный чекпойнт — фейковым TSA."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from apps.accounts.models import User
from apps.evidence import services as evidence_services
from apps.evidence.storage import FakeEvidenceObjectStore
from apps.evidence.tests._fixtures import jpeg_with_gps_exif_and_thumbnail, jpeg_without_exif
from apps.milestones.tests._execution_helpers import make_signed_contract_with_leaf, make_user
from apps.notifications.providers import DeliveryResult
from common import relay
from services.audit_vault import checkpoint as checkpoint_module
from services.audit_vault.providers import FakeTimestampAuthority
from services.audit_vault.storage import FakeCheckpointObjectStore


@dataclass
class RecordingEmailProvider:
    provider_code: str = "email_recording"
    messages: list[tuple[User, dict[str, object]]] = field(default_factory=list)

    def send(self, recipient: User, message: dict[str, object]) -> DeliveryResult:
        self.messages.append((recipient, message))
        return DeliveryResult(delivered=True, provider_message_id="rec", status="sent")


def make_deal(suffix: str) -> tuple[Any, Any, User, User, FakeEvidenceObjectStore]:
    customer = make_user(f"a{suffix}1")
    contractor = make_user(f"a{suffix}2")
    customer.email = f"customer{suffix}@example.test"
    customer.save(update_fields=["email"])
    contractor.email = f"contractor{suffix}@example.test"
    contractor.save(update_fields=["email"])
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    return contract, milestone, customer, contractor, FakeEvidenceObjectStore()


def upload(contract, milestone, user, store, *, name="photo.jpg", with_thumbnail=False):
    content = jpeg_with_gps_exif_and_thumbnail() if with_thumbnail else jpeg_without_exif()
    return evidence_services.upload_evidence(
        contract,
        user=user,
        content=content,
        file_name=name,
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        object_store=store,
    )


def relay_all() -> None:
    """Все outbox-события -> подписчики (в т.ч. Audit Vault). Несколько
    проходов: подписчики сами публикуют события."""
    for _ in range(5):
        if relay.deliver_due_events() == 0:
            break


def checkpoint():
    return checkpoint_module.compute_daily_checkpoint(
        provider=FakeTimestampAuthority(), store=FakeCheckpointObjectStore()
    )
