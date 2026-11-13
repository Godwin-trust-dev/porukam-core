"""chore/sphere-dedup — реальные перепривязки существующих ссылок с
`tutoring` на `education`: apps.catalog.migrations.
0014_dedupe_tutoring_into_education / 0015_deactivate_or_delete_tutoring_sphere,
apps.milestones.migrations.0005_repoint_tutoring_milestones_to_education,
apps.profiles.migrations.0004_dedupe_tutoring_into_education,
apps.reputation.migrations.0002_dedupe_tutoring_sphere_codes,
apps.contracts.migrations.0007_dedupe_tutoring_sphere_code_form_data.

К моменту прогона этих тестов миграции уже применены к тестовой БД
(pytest-django прогоняет весь граф) — но применены «в вакууме»: миграция
0006 сеет `tutoring` и тут же следом 0014/0015 его убирают, реальных
ссылок (Milestone/PortfolioProject/DealFact/Contract.form_data) в процессе
ни разу не появляется. Чтобы проверить поведение НА СУЩЕСТВУЮЩИХ ссылках
(как будет на проде — эти данные уже накоплены до раскатки ветки), тест
воссоздаёт `tutoring`-сценарий вручную и вызывает функции миграций
НАПРЯМУЮ (`importlib`, файлы миграций — обычные импортируемые модули) —
это те же функции, что выполнит `manage.py migrate`, не копия логики.

Расположен в apps.milestones.tests (не apps.catalog.tests): apps.catalog —
нижний слой import-linter, ни от кого не зависит (CLAUDE.md) — импортировать
sюда apps.profiles/apps.contracts/apps.reputation для этого теста было бы
нарушением контракта. apps.milestones уже легитимно зависит от всех них."""

from __future__ import annotations

import importlib

import pytest
from django.apps import apps as live_apps

from apps.catalog.models import ChecklistTemplateItem, MaterialCatalogItem, Sphere
from apps.milestones.models import Milestone
from apps.profiles.models import Portfolio, PortfolioProject, Profile
from apps.reputation.models import DealFact
from common.uuid7 import uuid7

from ._helpers import make_contract, make_user

pytestmark = pytest.mark.django_db

_catalog_0014 = importlib.import_module(
    "apps.catalog.migrations.0014_dedupe_tutoring_into_education"
)
_catalog_0015 = importlib.import_module(
    "apps.catalog.migrations.0015_deactivate_or_delete_tutoring_sphere"
)
_milestones_0005 = importlib.import_module(
    "apps.milestones.migrations.0005_repoint_tutoring_milestones_to_education"
)
_profiles_0004 = importlib.import_module(
    "apps.profiles.migrations.0004_dedupe_tutoring_into_education"
)
_reputation_0002 = importlib.import_module(
    "apps.reputation.migrations.0002_dedupe_tutoring_sphere_codes"
)
_contracts_0007 = importlib.import_module(
    "apps.contracts.migrations.0007_dedupe_tutoring_sphere_code_form_data"
)


@pytest.fixture
def tutoring_sphere() -> Sphere:
    """Тестовая БД уже прогнала 0014/0015 — `tutoring` там уже убран.
    Заводим заново, как будто дедуп ещё не раскатан (реалистичный прод-сценарий)."""
    sphere, _ = Sphere.objects.get_or_create(
        code="tutoring", defaults={"name_i18n": {"ru": "Репетиторство"}, "is_active": True}
    )
    return sphere


def test_migration_repoints_all_existing_references_and_removes_tutoring(tutoring_sphere):
    # --- education уже существует (заведён миграцией 0014 при построении
    # тестовой БД, тот же приём, что более ранний import_checklists) —
    # дедуп не должен его пересоздавать/трогать его пункты.
    education_sphere = Sphere.objects.get(code="education")
    # "other_education" — уже переименован из "other_tutoring" РЕАЛЬНЫМ
    # прогоном 0014 при построении тестовой БД; убираем его здесь, чтобы
    # честно смоделировать состояние ДО дедупа (см. `tutoring_sphere` —
    # та же логика: `tutoring`-сфера тоже заводится заново).
    MaterialCatalogItem.objects.filter(code="other_education").delete()
    untouched_item = ChecklistTemplateItem.objects.create(
        sphere=education_sphere,
        slug="education.school.math_tutoring.1",
        version=1,
        is_current=True,
        category="school",
        code="math_tutoring.1",
        description="исходный текст",
        measurable_criterion="исходный текст",
    )

    # --- catalog: материал + сферный пункт чек-листа на tutoring ---
    material = MaterialCatalogItem.objects.create(
        code="other_tutoring", sphere=tutoring_sphere, name_i18n={"ru": "Прочее"}
    )
    checklist_item = ChecklistTemplateItem.objects.create(
        sphere=tutoring_sphere, description="x", measurable_criterion="x"
    )

    # --- milestones: Milestone.sphere — единственный настоящий PROTECT FK ---
    customer, contractor = make_user("d1"), make_user("d2")
    contract = make_contract(customer=customer, contractor=contractor)
    milestone = Milestone.objects.create(contract=contract, title="урок", sphere=tutoring_sphere)

    # --- profiles: PortfolioProject.sphere — плоский код без FK ---
    # `make_contract` (contracts_services.create_draft) уже завёл PERSON-
    # профиль заказчику (unique_profile_kind_owner_user) — переиспользуем,
    # не создаём второй.
    profile = Profile.objects.get(owner_user=customer, kind=Profile.Kind.PERSON)
    portfolio = Portfolio.objects.create(profile=profile)
    project = PortfolioProject.objects.create(
        portfolio=portfolio, title="Репетиторство по математике", sphere="tutoring"
    )

    # --- reputation: DealFact.sphere_codes — JSON-список без FK ---
    deal_fact = DealFact.objects.create(contract_id=uuid7(), sphere_codes=["tutoring", "it"])

    # --- contracts: Contract.form_data["sphere_code"] — живой черновик ---
    contract.form_data = {**contract.form_data, "sphere_code": "tutoring"}
    contract.save(update_fields=["form_data"])

    # --- тот же порядок, что в реальном графе миграций (dependencies) ---
    _catalog_0014.dedupe_forward(live_apps, None)
    _milestones_0005.repoint_forward(live_apps, None)
    _profiles_0004.repoint_forward(live_apps, None)
    _reputation_0002.repoint_forward(live_apps, None)
    _contracts_0007.repoint_forward(live_apps, None)
    _catalog_0015.finalize_forward(live_apps, None)

    # tutoring удалена целиком (все ссылки были перепривязаны заранее).
    assert not Sphere.objects.filter(code="tutoring").exists()

    material.refresh_from_db()
    assert material.code == "other_education"
    assert material.sphere_id == education_sphere.id

    checklist_item.refresh_from_db()
    assert checklist_item.sphere_id == education_sphere.id

    milestone.refresh_from_db()
    assert milestone.sphere_id == education_sphere.id

    project.refresh_from_db()
    assert project.sphere == "education"

    deal_fact.refresh_from_db()
    assert deal_fact.sphere_codes == ["education", "it"]  # порядок и "it" сохранены

    contract.refresh_from_db()
    assert contract.form_data["sphere_code"] == "education"

    # Слаг импортированного education-пункта, заведённого ДО дедупа, — не тронут.
    untouched_item.refresh_from_db()
    assert untouched_item.slug == "education.school.math_tutoring.1"
    assert untouched_item.description == "исходный текст"
    assert untouched_item.sphere_id == education_sphere.id


def test_finalize_deactivates_tutoring_when_still_protected_elsewhere(tutoring_sphere):
    """Если что-то всё же не успело перепривязаться (например, отдельный
    прогон миграций без 0005 milestones в этом же окне) — delete() падает
    ProtectedError, 0015 обязана мягко деактивировать, а не уронить деплой."""
    _catalog_0014.dedupe_forward(live_apps, None)

    customer, contractor = make_user("p1"), make_user("p2")
    contract = make_contract(customer=customer, contractor=contractor)
    Milestone.objects.create(contract=contract, title="урок", sphere=tutoring_sphere)
    # milestones-репоинт НЕ вызываем — Milestone всё ещё держит tutoring (PROTECT).

    _catalog_0015.finalize_forward(live_apps, None)

    tutoring_sphere.refresh_from_db()
    assert tutoring_sphere.is_active is False
    assert Sphere.objects.filter(code="tutoring").exists()  # не удалена — только деактивирована


def test_deactivated_tutoring_is_excluded_from_new_milestone_assignment(tutoring_sphere):
    """«Исключение из всех выдач» (постановка) — деактивированная сфера
    больше не резолвится для НОВЫХ милстоунов (apps.milestones.services.
    _resolve_sphere), хотя старые ссылки (PROTECT) остаются валидными."""
    from apps.milestones import services
    from apps.milestones.services import SphereNotFoundError

    tutoring_sphere.is_active = False
    tutoring_sphere.save(update_fields=["is_active"])

    customer, contractor = make_user("i1"), make_user("i2")
    contract = make_contract(customer=customer, contractor=contractor)
    with pytest.raises(SphereNotFoundError):
        services.create_milestone(
            contract=contract, user=customer, title="новый", sphere_code="tutoring"
        )
