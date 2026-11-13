"""GET /v1/{spheres,work-types,material-catalog,units,checklist-recommendations}
(ADR-091) — HTTP-слой поверх apps/catalog/tests/test_selectors.py. Все пути —
AllowAny (справочники, не персональные данные, тот же уровень, что apps.l10n)."""

from __future__ import annotations

from pathlib import Path

import pytest
from rest_framework.test import APIClient

from apps.catalog import selectors, services
from apps.catalog.models import ChecklistTemplatePickStat

pytestmark = pytest.mark.django_db

_REPO_CHECKLISTS_DIR = Path(__file__).resolve().parents[4] / "docs" / "content" / "checklists"


@pytest.fixture
def imported():
    return services.import_checklists(_REPO_CHECKLISTS_DIR)


@pytest.fixture
def client() -> APIClient:
    return APIClient()


@pytest.fixture
def l10n_packs():
    """Реальные ru/en-пакеты репозитория (l10n/packs) — источник имён сфер
    для не-ru локалей и имён категорий (`catalog.categories`, ADR-097)."""
    import json

    from apps.l10n import services as l10n_services

    packs_dir = Path(__file__).resolve().parents[4] / "l10n" / "packs"
    for code in ("ru", "en"):
        l10n_services.import_pack(json.loads((packs_dir / f"{code}.json").read_text("utf-8")))


# --- /spheres -----------------------------------------------------------


def test_spheres_no_auth_required(client):
    resp = client.get("/v1/spheres")
    assert resp.status_code == 200, resp.content


def test_spheres_without_q_returns_all_active_not_empty(client):
    """SpherePicker «Все сферы» падает на этот же результат без q
    (ADR-091 §4) — не может быть пустым."""
    resp = client.get("/v1/spheres")
    codes = {s["code"] for s in resp.data["results"]}
    assert "renovation" in codes
    assert resp.data["popular"] == []


def test_spheres_q_prefix_filters_by_localized_name(client):
    resp = client.get("/v1/spheres", {"q": "рем"})
    names = [s["name"] for s in resp.data["results"]]
    assert names == ["Ремонт и строительство"]


def test_spheres_q_typo_still_finds(client):
    """ADR-097: опечатка в пределах допуска (1 на токен из 4–7 символов)
    не должна давать пустой результат."""
    resp = client.get("/v1/spheres", {"q": "римонт"})
    assert "renovation" in {s["code"] for s in resp.data["results"]}


def test_spheres_q_extra_word_still_finds(client):
    """ADR-097: запрос из собственного плейсхолдера UI («ремонт кухни»)
    обязан находить сферу по совпавшему токену."""
    resp = client.get("/v1/spheres", {"q": "ремонт кухни"})
    assert "renovation" in {s["code"] for s in resp.data["results"]}


def test_spheres_q_matches_category_label(client, l10n_packs):
    """ADR-097: имя категории из пакета (`catalog.categories`) — кандидат
    поиска её сферы («сантехника» → renovation)."""
    resp = client.get("/v1/spheres", {"q": "сантехника"})
    assert [s["code"] for s in resp.data["results"]] == ["renovation"]


def test_spheres_en_name_prefers_pack(client, l10n_packs):
    """ADR-097: для не-ru локали имя сферы — из пакета (там полное имя,
    в отличие от куцего name_i18n["en"])."""
    resp = client.get("/v1/spheres", {"q": "renov"}, HTTP_ACCEPT_LANGUAGE="en")
    assert [s["name"] for s in resp.data["results"]] == ["Renovation & construction"]


def test_spheres_ru_name_stays_on_name_i18n(client, l10n_packs):
    """RU-контур не переезжает на пакеты (докстринг apps.l10n.selectors):
    имя для ru — по-прежнему из name_i18n, даже когда ru-пакет импортирован."""
    resp = client.get("/v1/spheres")
    renovation = next(s for s in resp.data["results"] if s["code"] == "renovation")
    assert renovation["name"] == "Ремонт и строительство"


def test_spheres_q_no_match_is_empty_not_error(client):
    resp = client.get("/v1/spheres", {"q": "zzzzz-no-such-sphere"})
    assert resp.status_code == 200
    assert resp.data["results"] == []


def test_spheres_accept_language_en_changes_name(client):
    resp = client.get("/v1/spheres", {"q": "renov"}, HTTP_ACCEPT_LANGUAGE="en")
    assert [s["name"] for s in resp.data["results"]] == ["Renovation & construction"]


def test_spheres_q_without_import_has_no_work_types(client, l10n_packs):
    """ADR-100: без импортированного контента чек-листов типов работ нет —
    кандидаты только пары с реальными пунктами (иначе выбор вёл бы в пустые
    рекомендации)."""
    resp = client.get("/v1/spheres", {"q": "мебель"})
    assert resp.data["work_types"] == []


def test_spheres_q_suggests_work_type_directly(client, imported, l10n_packs):
    """ADR-100 (замечание отсмотра 2026-08-20): «мебель» должна предлагать
    тип работ «Мебель: сборка и ремонт» вместе с его сферой, а не только
    сферу «Ремонт и строительство»."""
    resp = client.get("/v1/spheres", {"q": "мебель"})
    hits = resp.data["work_types"]
    assert hits, resp.data
    top = hits[0]
    assert top["code"] == "furniture"
    assert top["name"] == "Мебель: сборка и ремонт"
    assert top["sphere_code"] == "renovation"
    assert top["sphere_name"] == "Ремонт и строительство"


def test_spheres_q_work_types_localized_en(client, imported, l10n_packs):
    resp = client.get("/v1/spheres", {"q": "furniture"}, HTTP_ACCEPT_LANGUAGE="en")
    top = resp.data["work_types"][0]
    assert top["code"] == "furniture"
    assert top["name"] == "Furniture assembly & repair"
    assert top["sphere_name"] == "Renovation & construction"


def test_spheres_q_work_types_ru_query_on_en_locale(client, imported, l10n_packs):
    """Двуязычный запрос: русское слово на EN-интерфейсе находит тип работ
    (ru-имена — всегда в кандидатах, как у категорий сфер в ADR-097)."""
    resp = client.get("/v1/spheres", {"q": "мебель"}, HTTP_ACCEPT_LANGUAGE="en")
    assert resp.data["work_types"][0]["code"] == "furniture"


def test_spheres_without_q_work_types_empty(client, imported, l10n_packs):
    resp = client.get("/v1/spheres")
    assert resp.data["work_types"] == []


# --- /work-types ----------------------------------------------------------


def test_work_types_requires_sphere(client):
    resp = client.get("/v1/work-types")
    assert resp.status_code == 400


def test_work_types_empty_before_import(client):
    resp = client.get("/v1/work-types", {"sphere": "renovation"})
    assert resp.status_code == 200
    assert resp.data["results"] == []


def test_work_types_without_packs_is_empty(client, imported):
    """ADR-190 (12.09): без импортированных языковых пакетов НИ у одной
    категории нет подписи — выдача пуста, а не сырые коды (прежнее
    поведение ADR-091 §1 "name == code" отменено ADR-190)."""
    resp = client.get("/v1/work-types", {"sphere": "renovation"})
    assert resp.status_code == 200, resp.content
    assert resp.data["results"] == []


def test_work_types_localized_from_pack_ru(client, imported, l10n_packs):
    """ADR-097: человекочитаемое имя категории — из
    `catalog.categories.<сфера>.<код>` языкового пакета (для ru тоже:
    у категории нет name_i18n)."""
    resp = client.get("/v1/work-types", {"sphere": "renovation"})
    item = next(w for w in resp.data["results"] if w["code"] == "turnkey")
    assert item["name"] == "Комплексный ремонт под ключ"
    assert item["sphere_code"] == "renovation"


def test_work_types_localized_from_pack_en(client, imported, l10n_packs):
    resp = client.get("/v1/work-types", {"sphere": "renovation"}, HTTP_ACCEPT_LANGUAGE="en")
    item = next(w for w in resp.data["results"] if w["code"] == "turnkey")
    assert item["name"] == "Full turnkey renovation"


def test_work_types_excludes_codes_without_label_anywhere(client, imported, l10n_packs):
    """ADR-190 (12.09, решение владельца): 4 кода сферы `other`
    (`loan`/`rent_home`/`rent_items`/`sale_vehicle` — social-архетипы займа/
    аренды/продажи, не услуги) без подписи ни в одной локали — не
    показываются видом работ. `other.other` (универсальный шаблон, подпись
    «Прочее» есть) при этом ОСТАЁТСЯ."""
    resp = client.get("/v1/work-types", {"sphere": "other"})
    codes = {w["code"] for w in resp.data["results"]}
    assert codes.isdisjoint({"loan", "rent_home", "rent_items", "sale_vehicle"})
    assert "other" in codes


def test_work_types_excludes_unlabeled_codes_in_en_locale_too(client, imported, l10n_packs):
    resp = client.get("/v1/work-types", {"sphere": "other"}, HTTP_ACCEPT_LANGUAGE="en")
    codes = {w["code"] for w in resp.data["results"]}
    assert codes.isdisjoint({"loan", "rent_home", "rent_items", "sale_vehicle"})


# --- /material-catalog ------------------------------------------------------


def test_material_catalog_no_params_returns_seeded_items(client):
    resp = client.get("/v1/material-catalog")
    assert resp.status_code == 200, resp.content
    refs = {m["ref"] for m in resp.data["results"]}
    assert "renovation_tile" in refs
    item = next(m for m in resp.data["results"] if m["ref"] == "renovation_tile")
    assert item["title"] == "Плитка керамическая"
    assert item["default_unit"] == "м²"


def test_material_catalog_other_item_has_null_default_unit(client):
    resp = client.get("/v1/material-catalog")
    other = next(m for m in resp.data["results"] if m["ref"] == "other_renovation")
    assert other["default_unit"] is None


def test_material_catalog_sphere_filter(client):
    resp = client.get("/v1/material-catalog", {"sphere": "renovation"})
    refs = {m["ref"] for m in resp.data["results"]}
    assert "renovation_tile" in refs
    assert "other_it" not in refs


# --- /units -----------------------------------------------------------------


def test_units_derived_from_material_catalog(client):
    resp = client.get("/v1/units")
    assert resp.status_code == 200, resp.content
    codes = {u["code"] for u in resp.data["results"]}
    assert "м²" in codes
    item = next(u for u in resp.data["results"] if u["code"] == "м²")
    assert item["label"] == "м²"


# --- /checklist-recommendations ----------------------------------------------


def test_checklist_recommendations_requires_both_params(client):
    assert client.get("/v1/checklist-recommendations").status_code == 400
    assert client.get("/v1/checklist-recommendations", {"sphere": "renovation"}).status_code == 400
    assert client.get("/v1/checklist-recommendations", {"workType": "turnkey"}).status_code == 400


def test_checklist_recommendations_returns_flat_string_list(client, imported):
    resp = client.get(
        "/v1/checklist-recommendations", {"sphere": "renovation", "workType": "turnkey"}
    )
    assert resp.status_code == 200, resp.content
    assert isinstance(resp.data["results"], list)
    assert all(isinstance(r, str) for r in resp.data["results"])
    assert len(resp.data["results"]) > 0


def test_checklist_recommendations_sphere_scoping_prevents_cross_sphere_leak(client, imported):
    sales = client.get(
        "/v1/checklist-recommendations", {"sphere": "sales", "workType": "other"}
    ).data["results"]
    other = client.get(
        "/v1/checklist-recommendations", {"sphere": "other", "workType": "other"}
    ).data["results"]
    assert "Товар соответствует описанию и фото из карточки сделки — сверка при передаче" in sales
    assert set(sales).isdisjoint(other)


def test_checklist_recommendations_empty_for_unknown_work_type(client, imported):
    resp = client.get(
        "/v1/checklist-recommendations", {"sphere": "renovation", "workType": "does-not-exist"}
    )
    assert resp.status_code == 200
    assert resp.data["results"] == []


# --- /contract-types ----------------------------------------------------


def test_contract_types_no_auth_required(client):
    assert client.get("/v1/contract-types").status_code == 200


def test_contract_types_without_param_returns_all_client_tree_types(client):
    """Без `client_option` — все 7 типов клиентского дерева Р1
    (docs/catalog-v2.md §1), скрытые/excluded не попадают (ADR-094)."""
    resp = client.get("/v1/contract-types")
    codes = [t["code"] for t in resp.data["results"]]
    assert codes == [
        "services_individual",
        "services_business",
        "sale_personal",
        "sale_business",
        "rent_items",
        "rent_home",
        "loan_individuals",
    ]


def test_contract_types_hidden_and_excluded_absent(client):
    resp = client.get("/v1/contract-types")
    codes = {t["code"] for t in resp.data["results"]}
    # sale_vehicle — client_option="sale", но is_hidden (special, Р2);
    # employment — excluded; оба не должны предлагаться мастеру.
    assert "sale_vehicle" not in codes
    assert "employment" not in codes


def test_contract_types_filter_by_client_option(client):
    resp = client.get("/v1/contract-types", {"client_option": "sale"})
    assert [t["code"] for t in resp.data["results"]] == ["sale_personal", "sale_business"]
    assert all(t["client_option"] == "sale" for t in resp.data["results"])


def test_contract_types_loan_single_code(client):
    resp = client.get("/v1/contract-types", {"client_option": "loan"})
    assert [t["code"] for t in resp.data["results"]] == ["loan_individuals"]


def test_contract_types_invalid_client_option_400(client):
    assert client.get("/v1/contract-types", {"client_option": "nonsense"}).status_code == 400


def test_contract_types_localized_name_ru_default(client):
    resp = client.get("/v1/contract-types", {"client_option": "loan"})
    assert resp.data["results"][0]["name"].startswith("Займ")


def test_contract_types_accept_language_en_changes_name(client):
    resp = client.get("/v1/contract-types", {"client_option": "sale"}, HTTP_ACCEPT_LANGUAGE="en")
    assert resp.data["results"][0]["name"].startswith("Sale")


def test_checklist_recommendations_response_shape_unchanged_by_ranking(client, imported):
    """ADR-153 меняет ПОРЯДОК, не форму: контракт остаётся `{results:
    string[]}` — фронт (мастер, подсказки критериев) не трогали."""
    # Последний ДЕФОЛТНЫЙ пункт: пиками он поднимается на первое место
    # (расширенный набор идёт после дефолтных при любом счётчике).
    item = [
        i
        for i in selectors.list_checklist_recommendations(
            sphere_code="renovation", work_type="turnkey"
        )
        if i.is_default
    ][-1]
    ChecklistTemplatePickStat.objects.create(slug=item.slug, pick_count=5)

    resp = client.get(
        "/v1/checklist-recommendations", {"sphere": "renovation", "workType": "turnkey"}
    )
    assert resp.status_code == 200, resp.content
    results = resp.data["results"]
    assert set(resp.data.keys()) == {"results"}
    assert all(isinstance(r, str) for r in results)
    assert results[0] == item.description


def test_checklist_recommendations_include_extended_set_after_defaults(client, imported):
    """Расширенный набор (`is_default=False`) теперь виден в подсказках —
    «пусть читают и умнеют» (ADR-153); дефолтные всё равно впереди."""
    ranked = list(
        selectors.list_checklist_recommendations(sphere_code="renovation", work_type="turnkey")
    )
    extended = [i.description for i in ranked if not i.is_default]
    assert extended, "нужна пара (сфера, вид работ) с необязательными пунктами"

    results = client.get(
        "/v1/checklist-recommendations", {"sphere": "renovation", "workType": "turnkey"}
    ).data["results"]
    assert set(extended) <= set(results)
    assert results.index(extended[0]) >= len([i for i in ranked if i.is_default])
