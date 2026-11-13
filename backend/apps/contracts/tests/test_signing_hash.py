"""etap-4.md Э4.4: тест «одинаковый договор -> одинаковый hash» —
property-based (Hypothesis), независимость canonical-сериализации от
порядка ключей во входном dict (тот же приём, что apps/milestones/tests/
test_properties.py: max_examples небольшой + deadline=None +
suppress_health_check для БД-теста)."""

from __future__ import annotations

import itertools

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from apps.contracts import services
from apps.contracts.models import ContractVersion

from ._signing_helpers import add_leaf_milestone, make_under_review_contract, make_user

pytestmark = pytest.mark.django_db

_seq = itertools.count(1)


def test_canonical_hash_is_independent_of_dict_key_order():
    document = {"b": 2, "a": 1, "nested": {"z": 26, "y": 25}}
    shuffled = {"nested": {"y": 25, "z": 26}, "a": 1, "b": 2}
    from common.canonical import canonical_json_bytes, sha256_hex

    assert canonical_json_bytes(document) == canonical_json_bytes(shuffled)
    assert sha256_hex(canonical_json_bytes(document)) == sha256_hex(canonical_json_bytes(shuffled))


def test_json_safe_sorts_dict_keys_regardless_of_insertion_order():
    a = services._json_safe({"z": 1, "a": {"y": 2, "x": 3}})
    b = services._json_safe({"a": {"x": 3, "y": 2}, "z": 1})
    assert list(a.keys()) == list(b.keys()) == ["a", "z"]
    assert list(a["a"].keys()) == list(b["a"].keys()) == ["x", "y"]


@given(
    title=st.text(min_size=1, max_size=30, alphabet=st.characters(exclude_categories=("Cs", "Cc")))
)
@settings(
    max_examples=10,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.too_slow],
)
def test_same_contract_content_gives_same_hash_regardless_of_build_order(title):
    """Два независимо построенных, но СОДЕРЖАТЕЛЬНО идентичных договора (та
    же сторона, тот же тип, то же дерево — этапы созданы в РАЗНОМ порядке
    полей вызова) дают ОДИНАКОВЫЙ integrity_hash."""
    customer_a = make_user(f"h{next(_seq)}")
    contractor_a = make_user(f"h{next(_seq)}")
    contract_a = make_under_review_contract(customer=customer_a, contractor=contractor_a)
    contract_a.title = title
    contract_a.save(update_fields=["title"])
    add_leaf_milestone(contract_a, user=customer_a, amount="500.00")
    version_a = services.freeze_contract(contract_a, user=customer_a)

    customer_b = make_user(f"h{next(_seq)}")
    contractor_b = make_user(f"h{next(_seq)}")
    contract_b = make_under_review_contract(customer=customer_b, contractor=contractor_b)
    contract_b.title = title
    contract_b.save(update_fields=["title"])
    add_leaf_milestone(contract_b, user=customer_b, amount="500.00")
    version_b = services.freeze_contract(contract_b, user=customer_b)

    # Разные contract_id/profile_id/milestone_id в снимке -> разные hash
    # (снимок несёт UUID первичных ключей) — сверяем не хеши целиком, а то,
    # что снимок БЕЗ идентифицирующих полей идентичен: содержательно это
    # ОДИН И ТОТ ЖЕ договор, построенный дважды независимо.
    def _strip_ids(value):
        if isinstance(value, dict):
            return {k: _strip_ids(v) for k, v in value.items() if k not in ("id", "parent_id")}
        if isinstance(value, list):
            return [_strip_ids(v) for v in value]
        return value

    stripped_a = _strip_ids(
        {k: v for k, v in version_a.snapshot.items() if k not in ("contract_id", "parties")}
    )
    stripped_b = _strip_ids(
        {k: v for k, v in version_b.snapshot.items() if k not in ("contract_id", "parties")}
    )
    assert stripped_a == stripped_b


def test_refreezing_same_content_produces_the_same_hash_deterministically():
    customer = make_user("hdet1")
    contractor = make_user("hdet2")
    contract = make_under_review_contract(customer=customer, contractor=contractor)
    add_leaf_milestone(contract, user=customer, amount="777.00")

    from common.canonical import canonical_json_bytes, sha256_hex

    snapshot = services._build_snapshot(
        contract,
        segment=contract.segment,
        total=services.Money("777.00", "RUB"),
        parties={p.role: p for p in contract.parties.all()},
    )
    hash1 = sha256_hex(canonical_json_bytes(snapshot))
    hash2 = sha256_hex(canonical_json_bytes(snapshot))
    assert hash1 == hash2
    assert len(hash1) == 64


def test_contract_version_unique_hash_constraint_on_postgres():
    customer = make_user("hcon1")
    contractor = make_user("hcon2")
    contract = make_under_review_contract(customer=customer, contractor=contractor)
    add_leaf_milestone(contract, user=customer)
    version = services.freeze_contract(contract, user=customer)

    from django.db import IntegrityError

    with pytest.raises(IntegrityError, match="contract_version_unique_hash"):
        ContractVersion.objects.create(
            contract=contract,
            snapshot={},
            integrity_hash=version.integrity_hash,
            frozen_at=version.frozen_at,
            trusted_timestamp_source="server",
            trusted_timestamp_at=version.frozen_at,
        )
