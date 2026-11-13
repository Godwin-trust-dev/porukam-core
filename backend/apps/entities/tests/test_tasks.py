import pytest

from apps.accounts.models import User
from apps.entities import services, tasks
from apps.entities.models import BusinessEntity
from apps.entities.providers import FakeEntityRegistryProvider
from apps.identity import services as identity_services
from apps.identity.providers import FakeEsiaProvider

pytestmark = pytest.mark.django_db

_esia = FakeEsiaProvider()
_registry = FakeEntityRegistryProvider()


def _verify(user: User, *, full_name: str, tax_id: str) -> None:
    _url, state = identity_services.build_authorize_url(user, provider=_esia)
    identity_services.complete_verification(
        user, code=f"{full_name}|{tax_id}", state=state, provider=_esia
    )


def test_reconcile_ownership_epochs_only_touches_claimed_entities():
    creator = User.objects.create(trust_id="trust-entities-task-1", phone="+79990800001")
    _verify(
        creator, full_name="Пётр Кузнецов", tax_id=FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN
    )
    claimed = services.register_business_entity(
        FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN,
        country="RU",
        created_by=creator,
        provider=_registry,
    )
    unclaimed = services.register_business_entity(
        FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN,
        country="RU",
        created_by=creator,
        provider=_registry,
    )

    tasks.reconcile_ownership_epochs()

    claimed.refresh_from_db()
    unclaimed.refresh_from_db()
    assert claimed.claim_status == BusinessEntity.ClaimStatus.CLAIMED
    assert claimed.ownership_epochs.count() == 1  # директор не менялся — новой эпохи нет
    assert unclaimed.ownership_epochs.count() == 1
