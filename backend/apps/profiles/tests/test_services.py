from __future__ import annotations

import datetime as dt

import pytest

from apps.accounts.models import User
from apps.entities import services as entities_services
from apps.entities.models import BusinessEntity
from apps.entities.providers import FakeEntityRegistryProvider
from apps.identity import services as identity_services
from apps.identity.providers import FakeEsiaProvider
from apps.profiles import selectors, services
from apps.profiles.models import Profile

pytestmark = pytest.mark.django_db

_esia = FakeEsiaProvider()
_registry = FakeEntityRegistryProvider()


def _verify(user: User, *, full_name: str, tax_id: str) -> None:
    _url, state = identity_services.build_authorize_url(user, provider=_esia)
    identity_services.complete_verification(
        user, code=f"{full_name}|{tax_id}", state=state, provider=_esia
    )
    user.refresh_from_db()


@pytest.fixture
def user() -> User:
    return User.objects.create(trust_id="trust-profiles-svc-1", phone="+79990840001")


@pytest.fixture
def entity(user: User) -> BusinessEntity:
    return BusinessEntity.objects.create(
        country_of_registration="RU",
        local_form_code="ru_ooo",
        tax_regime_code="ru_osn",
        name="ООО Ромашка",
        created_by=user,
    )


@pytest.fixture
def business_profile(entity: BusinessEntity) -> Profile:
    return Profile.objects.create(
        kind=Profile.Kind.BUSINESS,
        owner_entity=entity,
        profile_visibility=Profile.Visibility.PUBLIC,
    )


def test_create_person_profile_from_positive_consent(user: User):
    profile = services.create_person_profile(user, profile_public=True)
    assert profile.profile_visibility == Profile.Visibility.PUBLIC


def test_create_person_profile_from_negative_consent(user: User):
    profile = services.create_person_profile(user, profile_public=False)
    assert profile.profile_visibility == Profile.Visibility.LINK_AND_DEALS


def test_update_visibility_business_profile_locked(business_profile: Profile):
    """Дельта §2 тест 4: попытка выставить link_and_deals бизнес-профилю —
    отказ (гейт сервис-слоя, до записи/до IntegrityError)."""
    with pytest.raises(services.ProfileVisibilityLockedError):
        services.update_visibility(
            business_profile, profile_visibility=Profile.Visibility.LINK_AND_DEALS
        )
    business_profile.refresh_from_db()
    assert business_profile.profile_visibility == Profile.Visibility.PUBLIC


def test_update_visibility_business_profile_public_is_noop_allowed(business_profile: Profile):
    updated = services.update_visibility(
        business_profile, profile_visibility=Profile.Visibility.PUBLIC
    )
    assert updated.profile_visibility == Profile.Visibility.PUBLIC


def test_update_visibility_person_profile_can_switch(user: User):
    profile = services.create_person_profile(user, profile_public=True)
    updated = services.update_visibility(
        profile, profile_visibility=Profile.Visibility.LINK_AND_DEALS
    )
    assert updated.profile_visibility == Profile.Visibility.LINK_AND_DEALS


# --- catalog (дельта §2 тест 5) --------------------------------------------


def test_catalog_excludes_link_and_deals_person_profile(user: User, business_profile: Profile):
    person = services.create_person_profile(user, profile_public=False)
    catalog = list(selectors.list_catalog_profiles())
    assert business_profile in catalog
    assert person not in catalog
    # но профиль по-прежнему достижим напрямую — по ссылке/@handle
    assert Profile.objects.get(pk=person.pk) == person


def test_catalog_includes_public_person_profile(user: User):
    profile = services.create_person_profile(user, profile_public=True)
    assert profile in list(selectors.list_catalog_profiles())


def test_catalog_excludes_hidden_public_profile(user: User):
    profile = services.create_person_profile(user, profile_public=True)
    services.update_visibility(profile, hide_from_catalog=True)
    assert profile not in list(selectors.list_catalog_profiles())


# --- create_business_profile (etap-3.md 3.5: «по claim'нутому юрлицу») -----


def test_create_business_profile_requires_operable_entity(entity: BusinessEntity):
    with pytest.raises(entities_services.EntityNotOperableError):
        services.create_business_profile(entity.id)


def test_create_business_profile_for_claimed_entity(user: User):
    _verify(
        user,
        full_name="Пётр Сергеевич Кузнецов",
        tax_id=FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN,
    )
    claimed = entities_services.register_business_entity(
        FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN,
        country="RU",
        created_by=user,
        provider=_registry,
    )
    profile = services.create_business_profile(claimed.id)
    assert profile.profile_visibility == Profile.Visibility.PUBLIC
    assert profile.owner_entity_id == claimed.id


def test_create_business_profile_is_idempotent(user: User):
    _verify(
        user,
        full_name="Анна Викторовна Смирнова",
        tax_id=FakeEntityRegistryProvider.SELF_EMPLOYED_INN,
    )
    claimed = entities_services.register_business_entity(
        FakeEntityRegistryProvider.SELF_EMPLOYED_INN,
        country="RU",
        created_by=user,
        provider=_registry,
    )
    first = services.create_business_profile(claimed.id)
    second = services.create_business_profile(claimed.id)
    assert first.pk == second.pk


# --- update_profile (PATCH /profiles/{id}) ----------------------------------


def test_update_profile_requires_ownership(user: User):
    profile = services.create_person_profile(user, profile_public=True)
    other = User.objects.create(trust_id="trust-profiles-svc-other", phone="+79990840002")
    with pytest.raises(services.ProfilePermissionDeniedError):
        services.update_profile(profile, other, city_name="Москва")


def test_update_profile_owner_can_set_city(user: User):
    profile = services.create_person_profile(user, profile_public=True)
    updated = services.update_profile(profile, user, city_name="Казань", works_remotely=True)
    assert updated.city_name == "Казань"
    assert updated.works_remotely is True


# --- portfolio ----------------------------------------------------------


def test_create_portfolio_project_requires_ownership(user: User):
    profile = services.create_person_profile(user, profile_public=True)
    other = User.objects.create(trust_id="trust-profiles-svc-portfolio-other", phone="+79990840003")
    with pytest.raises(services.ProfilePermissionDeniedError):
        services.create_portfolio_project(
            profile,
            other,
            title="Ремонт кухни",
            sphere="renovation",
            completed_at=dt.date(2026, 1, 1),
        )


def test_create_and_list_portfolio_project(user: User):
    profile = services.create_person_profile(user, profile_public=True)
    project = services.create_portfolio_project(
        profile,
        user,
        title="Ремонт кухни",
        sphere="renovation",
        location_label="Москва, ЮЗАО",
        completed_at=dt.date(2026, 1, 1),
    )
    assert project.source == project.Source.MANUAL
    assert list(selectors.list_portfolio_projects(profile)) == [project]


def test_update_portfolio_project(user: User):
    profile = services.create_person_profile(user, profile_public=True)
    project = services.create_portfolio_project(
        profile, user, title="Черновик", sphere="it", completed_at=dt.date(2026, 1, 1)
    )
    updated = services.update_portfolio_project(project, user, title="Готово", order=1)
    assert updated.title == "Готово"
    assert updated.order == 1


def test_publish_manual_project_does_not_require_consent(user: User):
    profile = services.create_person_profile(user, profile_public=True)
    project = services.create_portfolio_project(
        profile, user, title="Сайт", sphere="it", completed_at=dt.date(2026, 1, 1)
    )
    published = services.publish_project(project, user)
    assert published.is_published is True


def test_publish_from_contract_project_requires_counterparty_consent(user: User):
    """domain-model.md §3.4 publish_project — инвариант остаётся на месте,
    даже если FROM_CONTRACT в Р1 недостижим через обычный create-флоу."""
    profile = services.create_person_profile(user, profile_public=True)
    portfolio, _ = services.Portfolio.objects.get_or_create(profile=profile)
    project = services.PortfolioProject.objects.create(
        portfolio=portfolio,
        title="Из договора",
        sphere="it",
        source=services.PortfolioProject.Source.FROM_CONTRACT,
    )
    with pytest.raises(services.PortfolioConsentRequiredError):
        services.publish_project(project, user)
