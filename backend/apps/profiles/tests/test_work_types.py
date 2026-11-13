"""ADR-190 (12.09, «подсферы» в профиле и поиске): виды работ профиля —
составные коды `<сфера>.<категория>` каталога, согласованные со
`sphere_codes` (ADR-122). Каждый запрет — отдельным тестом (CLAUDE.md)."""

from __future__ import annotations

import pytest
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.catalog.models import ChecklistTemplateItem, Sphere
from apps.l10n import services as l10n_services
from apps.profiles import services
from apps.profiles.models import Profile

pytestmark = pytest.mark.django_db


def _pack(locale: str, categories: dict[str, str]) -> None:
    l10n_services.import_pack(
        {
            "locale": locale,
            "name": locale,
            "rtl": False,
            "quality": "reviewed",
            "pack_version": 1,
            "catalog": {"categories": categories},
        }
    )


@pytest.fixture
def owner():
    return User.objects.create(trust_id="trust-wt-1", phone="+79990971001")


@pytest.fixture
def profile(owner):
    return Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=owner, profile_visibility="public"
    )


@pytest.fixture
def spheres():
    return [
        Sphere.objects.get_or_create(code=code, defaults={"name_i18n": {"ru": code}})[0]
        for code in ("beauty", "repair", "it")
    ]


@pytest.fixture
def work_types(spheres):
    """`beauty.nails`/`repair.tiling` — реальные пункты чек-листа с
    подписью в ru; `repair.unlabeled` — пункт есть, подписи нет (аналог 4
    кодов `other.*`, ADR-190)."""
    beauty, repair, _it = spheres
    ChecklistTemplateItem.objects.create(
        sphere=beauty, category="nails", description="x", measurable_criterion="x"
    )
    ChecklistTemplateItem.objects.create(
        sphere=repair, category="tiling", description="x", measurable_criterion="x"
    )
    ChecklistTemplateItem.objects.create(
        sphere=repair, category="unlabeled", description="x", measurable_criterion="x"
    )
    _pack("ru", {"beauty.nails": "Маникюр", "repair.tiling": "Плитка"})
    _pack("en", {"beauty.nails": "Manicure", "repair.tiling": "Tiling"})


# --- update_profile: успешные пути -----------------------------------------


def test_update_work_types_dedupes_and_keeps_order(owner, profile, work_types):
    updated = services.update_profile(
        profile,
        owner,
        sphere_codes=["beauty", "repair"],
        work_type_codes=["repair.tiling", "beauty.nails", "repair.tiling"],
    )
    assert updated.work_type_codes == ["repair.tiling", "beauty.nails"]


def test_update_work_types_without_sphere_change_checks_stored_spheres(owner, profile, work_types):
    services.update_profile(profile, owner, sphere_codes=["beauty", "repair"])
    updated = services.update_profile(profile, owner, work_type_codes=["beauty.nails"])
    assert updated.work_type_codes == ["beauty.nails"]


# --- Запрет: формат -----------------------------------------------------


def test_update_work_types_rejects_malformed_code(owner, profile, work_types):
    services.update_profile(profile, owner, sphere_codes=["beauty"])
    with pytest.raises(services.ProfileWorkTypesInvalidError):
        services.update_profile(profile, owner, work_type_codes=["no-dot-here"])


# --- Запрет: неизвестный/неподписанный вид работ ---------------------------


def test_update_work_types_rejects_unknown_category(owner, profile, work_types):
    services.update_profile(profile, owner, sphere_codes=["beauty"])
    with pytest.raises(services.ProfileWorkTypesInvalidError):
        services.update_profile(profile, owner, work_type_codes=["beauty.does-not-exist"])


def test_update_work_types_rejects_unlabeled_category(owner, profile, work_types):
    """`repair.unlabeled` — пункт чек-листа есть, подписи нет: тот же
    критерий, что исключает 4 кода `other.*` из GET /work-types (ADR-190)."""
    services.update_profile(profile, owner, sphere_codes=["repair"])
    with pytest.raises(services.ProfileWorkTypesInvalidError):
        services.update_profile(profile, owner, work_type_codes=["repair.unlabeled"])


# --- Запрет: сфера вида работ не заявлена -----------------------------------


def test_update_work_types_rejects_sphere_not_declared(owner, profile, work_types):
    services.update_profile(profile, owner, sphere_codes=["beauty"])
    with pytest.raises(services.ProfileWorkTypeSphereNotDeclaredError):
        services.update_profile(profile, owner, work_type_codes=["repair.tiling"])


def test_update_work_types_and_spheres_together_uses_new_spheres(owner, profile, work_types):
    """Сферы и виды работ в ОДНОМ PATCH — согласованность проверяется
    относительно ИТОГОВЫХ (новых) sphere_codes, не старых."""
    updated = services.update_profile(
        profile, owner, sphere_codes=["repair"], work_type_codes=["repair.tiling"]
    )
    assert updated.work_type_codes == ["repair.tiling"]

    with pytest.raises(services.ProfileWorkTypeSphereNotDeclaredError):
        services.update_profile(
            profile, owner, sphere_codes=["beauty"], work_type_codes=["repair.tiling"]
        )


# --- Запрет: лимит --------------------------------------------------------


def test_update_work_types_rejects_over_limit(owner, profile, spheres):
    beauty, _repair, _it = spheres
    codes = []
    for i in range(services.PROFILE_MAX_WORK_TYPES + 1):
        category = f"cat{i}"
        ChecklistTemplateItem.objects.create(
            sphere=beauty, category=category, description="x", measurable_criterion="x"
        )
        codes.append(f"beauty.{category}")
    _pack("ru", {f"beauty.cat{i}": f"Категория {i}" for i in range(len(codes))})

    services.update_profile(profile, owner, sphere_codes=["beauty"])
    with pytest.raises(services.ProfileWorkTypesLimitError):
        services.update_profile(profile, owner, work_type_codes=codes)


# --- Обрезка осиротевших видов работ при сужении sphere_codes ---------------


def test_narrowing_spheres_prunes_orphaned_work_types(owner, profile, work_types):
    services.update_profile(
        profile,
        owner,
        sphere_codes=["beauty", "repair"],
        work_type_codes=["beauty.nails", "repair.tiling"],
    )
    updated = services.update_profile(profile, owner, sphere_codes=["beauty"])
    assert updated.work_type_codes == ["beauty.nails"]


def test_narrowing_spheres_keeps_work_types_when_both_declared_together(owner, profile, work_types):
    """Если `work_type_codes` передан В ТОМ ЖЕ PATCH, что сужает сферы —
    обрезка НЕ подменяет явную валидацию: несогласованный код 422-ит, а не
    молча выпадает."""
    services.update_profile(
        profile,
        owner,
        sphere_codes=["beauty", "repair"],
        work_type_codes=["beauty.nails", "repair.tiling"],
    )
    with pytest.raises(services.ProfileWorkTypeSphereNotDeclaredError):
        services.update_profile(
            profile, owner, sphere_codes=["beauty"], work_type_codes=["repair.tiling"]
        )


# --- API-слой --------------------------------------------------------------


def test_patch_profile_work_types_api(owner, profile, work_types):
    client = APIClient()
    client.force_authenticate(user=owner)
    resp = client.patch(
        f"/v1/profiles/{profile.id}",
        {"sphere_codes": ["beauty"], "work_type_codes": ["beauty.nails"]},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["work_type_codes"] == ["beauty.nails"]

    bad = client.patch(
        f"/v1/profiles/{profile.id}", {"work_type_codes": ["repair.tiling"]}, format="json"
    )
    assert bad.status_code == 422 and bad.data["code"] == "work_type_sphere_not_declared"

    unknown = client.patch(
        f"/v1/profiles/{profile.id}", {"work_type_codes": ["beauty.does-not-exist"]}, format="json"
    )
    assert unknown.status_code == 422 and unknown.data["code"] == "invalid_work_type"


def test_get_profile_returns_work_type_codes(owner, profile, work_types):
    services.update_profile(
        profile, owner, sphere_codes=["beauty"], work_type_codes=["beauty.nails"]
    )
    client = APIClient()
    resp = client.get(f"/v1/profiles/{profile.id}")
    assert resp.status_code == 200
    assert resp.data["work_type_codes"] == ["beauty.nails"]
