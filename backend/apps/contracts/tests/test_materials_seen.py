"""ADR-158: серверная отметка «материалы этапов просмотрены» (решение
владельца 05.09). До неё бейдж «Материалы изменены контрагентом» гас только
в браузере, где по нему кликнули, — смена устройства поднимала его заново.

Проверяется: сервис (участник ставит; чужой — 403 через API/NotAPartyError;
повтор идемпотентен; отметка монотонна и зажата «сейчас»; вторая сторона не
затрагивается), эндпоинт `POST /contracts/{id}/materials-seen` и выдача
`materials_seen_at` в `GET /contracts/{id}`.
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.contracts import selectors, services
from apps.contracts.models import Contract, ContractParty
from apps.profiles.models import Profile

from ._signing_helpers import make_under_review_contract, make_user

pytestmark = pytest.mark.django_db


def _api(user: User) -> APIClient:
    api = APIClient()
    api.force_authenticate(user=user)
    return api


@pytest.fixture
def customer() -> User:
    return make_user("ms01")


@pytest.fixture
def contractor() -> User:
    return make_user("ms02")


@pytest.fixture
def contract(customer: User, contractor: User) -> Contract:
    return make_under_review_contract(customer=customer, contractor=contractor)


def _party(contract: Contract, role: str) -> ContractParty:
    return contract.parties.get(role=role)


# --- сервис ---------------------------------------------------------------


def test_party_marks_materials_seen(contract: Contract, customer: User) -> None:
    before = timezone.now()
    party = services.mark_materials_seen(contract, user=customer)

    assert party.role == ContractParty.Role.CUSTOMER
    assert party.materials_seen_at is not None
    assert party.materials_seen_at >= before
    assert _party(contract, "customer").materials_seen_at == party.materials_seen_at


def test_repeat_with_same_moment_is_idempotent(contract: Contract, customer: User) -> None:
    """Повтор той же отметки не двигает её и не создаёт нового состояния —
    поэтому эндпоинту не нужен Idempotency-Key."""
    moment = timezone.now() - timedelta(minutes=5)
    first = services.mark_materials_seen(contract, user=customer, seen_at=moment)
    second = services.mark_materials_seen(contract, user=customer, seen_at=moment)

    assert first.materials_seen_at == moment
    assert second.materials_seen_at == moment


def test_mark_is_monotonic_and_never_moves_back(contract: Contract, customer: User) -> None:
    later = timezone.now() - timedelta(minutes=1)
    earlier = timezone.now() - timedelta(hours=3)
    services.mark_materials_seen(contract, user=customer, seen_at=later)
    services.mark_materials_seen(contract, user=customer, seen_at=earlier)

    assert _party(contract, "customer").materials_seen_at == later


def test_future_moment_is_clamped_to_now(contract: Contract, customer: User) -> None:
    """Иначе клиент отметкой «просмотрено до 2099 года» навсегда заглушил бы
    бейдж по будущим правкам контрагента."""
    before = timezone.now()
    party = services.mark_materials_seen(
        contract, user=customer, seen_at=timezone.now() + timedelta(days=365 * 74)
    )
    assert party.materials_seen_at is not None
    assert before <= party.materials_seen_at <= timezone.now()


def test_second_side_is_not_affected(contract: Contract, customer: User) -> None:
    services.mark_materials_seen(contract, user=customer)

    assert _party(contract, "customer").materials_seen_at is not None
    assert _party(contract, "contractor").materials_seen_at is None


def test_each_side_keeps_its_own_mark(contract: Contract, customer: User, contractor: User) -> None:
    customer_moment = timezone.now() - timedelta(hours=2)
    contractor_moment = timezone.now() - timedelta(minutes=10)
    services.mark_materials_seen(contract, user=customer, seen_at=customer_moment)
    services.mark_materials_seen(contract, user=contractor, seen_at=contractor_moment)

    assert _party(contract, "customer").materials_seen_at == customer_moment
    assert _party(contract, "contractor").materials_seen_at == contractor_moment


def test_stranger_cannot_mark(contract: Contract) -> None:
    stranger = make_user("ms03")
    with pytest.raises(services.NotAPartyError):
        services.mark_materials_seen(contract, user=stranger)


# --- селектор -------------------------------------------------------------


def test_selector_returns_own_mark_only(
    contract: Contract, customer: User, contractor: User
) -> None:
    moment = timezone.now() - timedelta(minutes=7)
    services.mark_materials_seen(contract, user=customer, seen_at=moment)

    assert selectors.materials_seen_at(contract, customer) == moment
    assert selectors.materials_seen_at(contract, contractor) is None


def test_selector_for_stranger_is_none(contract: Contract, customer: User) -> None:
    services.mark_materials_seen(contract, user=customer)
    stranger = make_user("ms04")

    assert selectors.materials_seen_at(contract, stranger) is None


# --- API ------------------------------------------------------------------


def _mark_url(contract: Contract) -> str:
    return f"/v1/contracts/{contract.id}/materials-seen"


def test_api_marks_and_returns_state(contract: Contract, customer: User) -> None:
    resp = _api(customer).post(_mark_url(contract), {}, format="json")

    assert resp.status_code == 200, resp.content
    assert resp.data["materials_seen_at"] is not None
    assert _party(contract, "customer").materials_seen_at is not None


def test_api_accepts_explicit_moment_and_is_idempotent(contract: Contract, customer: User) -> None:
    moment = (timezone.now() - timedelta(minutes=30)).isoformat()
    api = _api(customer)
    first = api.post(_mark_url(contract), {"seen_at": moment}, format="json")
    second = api.post(_mark_url(contract), {"seen_at": moment}, format="json")

    assert first.status_code == 200, first.content
    assert second.status_code == 200, second.content
    assert first.data["materials_seen_at"] == second.data["materials_seen_at"]


def test_api_rejects_stranger_with_403(contract: Contract) -> None:
    stranger = make_user("ms05")
    resp = _api(stranger).post(_mark_url(contract), {}, format="json")

    assert resp.status_code == 403, resp.content
    assert resp.data["code"] == "permission_denied"
    assert _party(contract, "customer").materials_seen_at is None
    assert _party(contract, "contractor").materials_seen_at is None


def test_api_rejects_anonymous(contract: Contract) -> None:
    assert APIClient().post(_mark_url(contract), {}, format="json").status_code == 401


def test_api_rejects_broken_moment(contract: Contract, customer: User) -> None:
    resp = _api(customer).post(_mark_url(contract), {"seen_at": "позавчера"}, format="json")

    assert resp.status_code == 400, resp.content


# --- сериализация в карточке договора -------------------------------------


def test_contract_detail_exposes_own_mark(
    contract: Contract, customer: User, contractor: User
) -> None:
    moment = timezone.now() - timedelta(minutes=3)
    services.mark_materials_seen(contract, user=customer, seen_at=moment)

    mine = _api(customer).get(f"/v1/contracts/{contract.id}")
    theirs = _api(contractor).get(f"/v1/contracts/{contract.id}")

    assert mine.status_code == 200, mine.content
    assert mine.data["materials_seen_at"] is not None
    # Чужая отметка наружу не уходит: у контрагента своя, ещё пустая.
    assert theirs.data["materials_seen_at"] is None


def test_contract_detail_mark_is_null_before_first_view(contract: Contract, customer: User) -> None:
    resp = _api(customer).get(f"/v1/contracts/{contract.id}")

    assert resp.status_code == 200, resp.content
    assert resp.data["materials_seen_at"] is None


def test_contract_detail_reflects_mark_made_through_api(contract: Contract, customer: User) -> None:
    api = _api(customer)
    marked = api.post(_mark_url(contract), {}, format="json")
    detail = api.get(f"/v1/contracts/{contract.id}")

    # Сравниваем МОМЕНТЫ, а не строки: карточка отдаёт отметку через
    # SerializerMethodField (как `idle_deadline_at` рядом) и её рендерит
    # JSON-энкодер в UTC, а ответ отметки — через DateTimeField в часовом
    # поясе контура. Обе записи — валидный ISO 8601 одного и того же момента.
    assert parse_datetime(detail.json()["materials_seen_at"]) == parse_datetime(
        marked.json()["materials_seen_at"]
    )


def test_serializer_without_request_has_no_mark(contract: Contract, customer: User) -> None:
    """Прямой вызов сериализатора вне view (тот же случай, что у `warnings`):
    чью отметку отдавать — неизвестно."""
    from apps.contracts.api.serializers import ContractSerializer

    services.mark_materials_seen(contract, user=customer)
    assert ContractSerializer(contract).data["materials_seen_at"] is None


def test_profile_of_other_person_does_not_leak_mark(contract: Contract, customer: User) -> None:
    """Отметка привязана к СТОРОНЕ, а не к пользователю: посторонний с
    собственным профилем не сторона и получает 403 на карточку целиком."""
    stranger = make_user("ms06")
    Profile.objects.create(
        kind=Profile.Kind.PERSON,
        owner_user=stranger,
        profile_visibility=Profile.Visibility.LINK_AND_DEALS,
    )
    services.mark_materials_seen(contract, user=customer)

    resp = _api(stranger).get(f"/v1/contracts/{contract.id}")
    assert resp.status_code == 403, resp.content
