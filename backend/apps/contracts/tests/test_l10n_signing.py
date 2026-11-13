"""Л.1 (docs/tasks/l10n-wave.md, док 32 + уточнение v1.2 «финал», ADR-078)
— критерии приёмки §Л.1:

- ContractVersion.canonical_language (API: `official_language`) — считается
  автоматически при freeze (`services._resolve_official_language`):
  1. явный `Contract.language_override` (PATCH черновика, quality >= reviewed
     обязателен — иначе `LanguageNotEligibleError`);
  2. иначе — общий язык интерфейса ОБЕИХ сторон, если quality >= reviewed;
  3. иначе — фолбэк по jurisdiction: RU-контур -> "ru" (как было), GLOBAL ->
     "en". Мастера выбора языка в UI НЕТ — это автоматика + точечный PATCH.
- Снепшот при заморозке расширяется рендерами (ADR-078, «тонкий» вариант) —
  каждый со своим хешем, снаружи integrity_hash.
- version_hash по-прежнему считается от canonical-структуры Э4.4 — обратная
  совместимость хешей уже подписанных договоров (тест ниже — без изменений
  хешей).
- SignatureRequest.locale фиксирует locale реально показанного текста.
- /sign отдаёт disclaimer, ТОЛЬКО если locale подписанта != official_language.
"""

from __future__ import annotations

import re

import pytest
from rest_framework.test import APIClient

from apps.accounts.api.views import _sms_gateway
from apps.accounts.models import User
from apps.contracts import services
from apps.contracts.models import Contract
from apps.jurisdictions.models import JurisdictionConfig
from apps.l10n.models import Locale
from apps.profiles.models import Profile
from common.canonical import canonical_json_bytes, sha256_hex

from ._signing_helpers import add_leaf_milestone, make_under_review_contract, make_user

pytestmark = pytest.mark.django_db


def _seed_jurisdiction(country_code: str, locale: str) -> JurisdictionConfig:
    return JurisdictionConfig.objects.create(
        country_code=country_code,
        primary_locale=locale,
        default_currency_code="USD",
        allowed_currency_codes=["USD"],
    )


def _seed_locale(code: str, quality: str) -> Locale:
    return Locale.objects.create(code=code, name=code, quality=quality, enabled=True)


# --- Обратная совместимость хешей -------------------------------------------


def test_freeze_hash_unchanged_by_official_language_and_renders():
    """Критическое требование §Л.1 п.2: version_hash по-прежнему считается
    ТОЛЬКО от canonical-структуры Э4.4 — рендеры/official_language не входят
    во вход хеша. Строим snapshot напрямую (как test_signing_hash.py делал
    ДО этой ветки) и сверяем с тем, что реально пишет freeze_contract."""
    customer = make_user("l10nhash1")
    contractor = make_user("l10nhash2")
    contract = make_under_review_contract(customer=customer, contractor=contractor)
    add_leaf_milestone(contract, user=customer, amount="500.00")

    parties = {p.role: p for p in contract.parties.all()}
    expected_snapshot = services._build_snapshot(
        contract, segment=contract.segment, total=services.Money("500.00", "RUB"), parties=parties
    )
    expected_hash = sha256_hex(canonical_json_bytes(expected_snapshot))

    version = services.freeze_contract(contract, user=customer)

    assert version.integrity_hash == expected_hash
    assert version.snapshot == expected_snapshot
    assert len(version.integrity_hash) == 64


# --- Официальный язык: авторезолв ---------------------------------------------


def test_official_language_prefers_shared_reviewed_party_locale_over_jurisdiction_fallback():
    """Обе стороны с одним языком интерфейса ("es", quality=reviewed) — он
    побеждает фолбэк по jurisdiction, даже если jurisdiction="DE" (GLOBAL ->
    en, но это не наш случай)."""
    _seed_jurisdiction("ES", "es")
    _seed_locale("es", Locale.Quality.REVIEWED)

    customer = make_user("l10nshared1")
    contractor = make_user("l10nshared2")
    customer.country_code = "ES"
    contractor.country_code = "ES"
    customer.save(update_fields=["country_code"])
    contractor.save(update_fields=["country_code"])

    contract = make_under_review_contract(customer=customer, contractor=contractor)
    contract.jurisdiction = "DE"
    contract.save(update_fields=["jurisdiction"])
    add_leaf_milestone(contract, user=customer)

    version = services.freeze_contract(contract, user=customer)

    assert version.canonical_language == "es"
    assert set(version.renders.keys()) == {"es"}


def test_official_language_ignores_shared_locale_below_reviewed_quality():
    """Обе стороны делят один язык интерфейса, но его quality=machine —
    авторезолв его игнорирует и падает на фолбэк по jurisdiction (GLOBAL ->
    en), а не выдаёт непроверенный перевод за официальный текст."""
    _seed_jurisdiction("XX", "xx")
    _seed_locale("xx", Locale.Quality.MACHINE)

    customer = make_user("l10nmachine1")
    contractor = make_user("l10nmachine2")
    customer.country_code = "XX"
    contractor.country_code = "XX"
    customer.save(update_fields=["country_code"])
    contractor.save(update_fields=["country_code"])

    contract = make_under_review_contract(customer=customer, contractor=contractor)
    contract.jurisdiction = "DE"  # GLOBAL-дефолт -> "en"
    contract.save(update_fields=["jurisdiction"])
    add_leaf_milestone(contract, user=customer)

    version = services.freeze_contract(contract, user=customer)

    assert version.canonical_language == "en"


def test_official_language_falls_back_to_ru_circuit_when_party_locales_differ():
    """Стороны с разными языками интерфейса (customer -> en/GLOBAL, contractor
    -> ru/RU) — общего языка нет, официальный язык считается фолбэком по
    jurisdiction контракта. jurisdiction="RU" -> "ru", как было до Л.1."""
    customer = make_user("l10nrufallback1")
    contractor = make_user("l10nrufallback2")
    contractor.country_code = "RU"
    contractor.save(update_fields=["country_code"])
    # customer.country_code остаётся не выставленным -> GLOBAL -> "en",
    # отличается от "ru" contractor'а -> общего языка нет.

    contract = make_under_review_contract(customer=customer, contractor=contractor)
    contract.jurisdiction = "RU"
    contract.save(update_fields=["jurisdiction"])
    add_leaf_milestone(contract, user=customer)

    version = services.freeze_contract(contract, user=customer)

    assert version.canonical_language == "ru"


def test_official_language_falls_back_to_en_for_global_circuit_when_party_locales_differ():
    _seed_jurisdiction("ES", "es")
    customer = make_user("l10nenfallback1")
    contractor = make_user("l10nenfallback2")
    customer.country_code = "ES"
    customer.save(update_fields=["country_code"])
    # contractor остаётся GLOBAL -> "en", отличается от "es" customer'а.

    contract = make_under_review_contract(customer=customer, contractor=contractor)
    contract.jurisdiction = "DE"  # GLOBAL-дефолт -> "en"
    contract.save(update_fields=["jurisdiction"])
    add_leaf_milestone(contract, user=customer)

    version = services.freeze_contract(contract, user=customer)

    assert version.canonical_language == "en"


def test_official_language_uses_explicit_override_over_shared_locale_and_fallback():
    """`Contract.language_override` (PATCH черновика, уже провалидирован
    quality >= reviewed) побеждает и общий язык сторон, и фолбэк."""
    _seed_jurisdiction("ES", "es")
    _seed_locale("es", Locale.Quality.REVIEWED)
    _seed_locale("fr", Locale.Quality.REVIEWED)

    customer = make_user("l10noverride1")
    contractor = make_user("l10noverride2")
    customer.country_code = "ES"
    contractor.country_code = "ES"
    customer.save(update_fields=["country_code"])
    contractor.save(update_fields=["country_code"])

    contract = make_under_review_contract(customer=customer, contractor=contractor)
    contract.language_override = "fr"
    contract.save(update_fields=["language_override"])
    add_leaf_milestone(contract, user=customer)

    version = services.freeze_contract(contract, user=customer)

    assert version.canonical_language == "fr"
    assert set(version.renders.keys()) >= {"fr", "es"}


# --- patch_draft: PATCH черновика -----------------------------------------


def test_patch_draft_sets_language_override_when_quality_reviewed_or_better():
    _seed_locale("fr", Locale.Quality.REVIEWED)
    customer = make_user("l10npatch1")
    contractor = make_user("l10npatch2")
    contractor_profile = Profile.objects.create(
        kind=Profile.Kind.PERSON,
        owner_user=contractor,
        profile_visibility=Profile.Visibility.LINK_AND_DEALS,
    )
    draft = services.create_draft(
        user=customer,
        my_role="customer",
        client_option="service",
        counterparty_profile_id=contractor_profile.id,
        payment_method=Contract.PaymentMethod.CASH,
        payment_order=Contract.PaymentOrder.AFTER_ACCEPTANCE,
        title="Ремонт крана",
    )

    updated = services.patch_draft(draft, user=customer, language="fr")

    assert updated.language_override == "fr"


def test_patch_draft_rejects_language_below_reviewed_quality():
    _seed_locale("xx", Locale.Quality.MACHINE)
    customer = make_user("l10npatchbad1")
    contractor = make_user("l10npatchbad2")
    contractor_profile = Profile.objects.create(
        kind=Profile.Kind.PERSON,
        owner_user=contractor,
        profile_visibility=Profile.Visibility.LINK_AND_DEALS,
    )
    draft = services.create_draft(
        user=customer,
        my_role="customer",
        client_option="service",
        counterparty_profile_id=contractor_profile.id,
        payment_method=Contract.PaymentMethod.CASH,
        payment_order=Contract.PaymentOrder.AFTER_ACCEPTANCE,
        title="Ремонт крана",
    )

    with pytest.raises(services.LanguageNotEligibleError):
        services.patch_draft(draft, user=customer, language="xx")

    with pytest.raises(services.LanguageNotEligibleError):
        services.patch_draft(draft, user=customer, language="zz-does-not-exist")


# --- Рендеры ------------------------------------------------------------------


def test_freeze_generates_official_and_signer_locale_renders_with_hashes():
    """Приёмка §Л.1: официальный язык EN (фолбэк, стороны с разными
    локалями), подписант с языком ES -> в снепшоте оба рендера с хешами."""
    _seed_jurisdiction("ES", "es")

    customer = make_user("l10nes1")
    contractor = make_user("l10nes2")
    customer.country_code = "ES"
    customer.save(update_fields=["country_code"])

    contract = make_under_review_contract(customer=customer, contractor=contractor)
    contract.jurisdiction = "DE"  # официальный язык -> en (GLOBAL-дефолт, фолбэк)
    contract.save(update_fields=["jurisdiction"])
    add_leaf_milestone(contract, user=customer)

    version = services.freeze_contract(contract, user=customer)

    assert version.canonical_language == "en"
    assert set(version.renders.keys()) >= {"en", "es"}
    for language in ("en", "es"):
        render = version.renders[language]
        assert render["language"] == language
        assert len(render["hash"]) == 64
        assert render["document"]["language"] == language
    # Разные языки -> разные документы (тег language внутри) -> разные хеши.
    assert version.renders["en"]["hash"] != version.renders["es"]["hash"]


def test_freeze_render_for_official_language_only_when_all_parties_share_it():
    """Обе стороны с country_code="RU" (явно — `party_user`-резолвер не
    зависит от contract.jurisdiction, только от локали КАЖДОГО пользователя),
    общий язык "ru" (quality=reviewed) — единственный язык рендера, дублировать
    нечего."""
    customer = make_user("l10nplain1")
    contractor = make_user("l10nplain2")
    customer.country_code = "RU"
    customer.save(update_fields=["country_code"])
    contractor.country_code = "RU"
    contractor.save(update_fields=["country_code"])

    contract = make_under_review_contract(customer=customer, contractor=contractor)
    contract.jurisdiction = "RU"
    contract.save(update_fields=["jurisdiction"])
    add_leaf_milestone(contract, user=customer)

    version = services.freeze_contract(contract, user=customer)

    assert version.canonical_language == "ru"
    assert set(version.renders.keys()) == {"ru"}


# --- SignatureRequest.locale + disclaimer (API) --------------------------------


def _code_for(phone: str) -> str:
    for sent_phone, message in reversed(_sms_gateway.sent):
        if sent_phone == phone:
            match = re.search(r"\d{6}", message)
            assert match
            return match.group()
    raise AssertionError(f"код для {phone} не отправлялся")


def _login(client: APIClient, phone: str) -> User:
    resp = client.post("/v1/auth/otp/request", {"phone": phone}, format="json")
    assert resp.status_code == 200, resp.content
    resp = client.post(
        "/v1/auth/otp/verify", {"phone": phone, "code": _code_for(phone)}, format="json"
    )
    assert resp.status_code == 200, resp.content
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {resp.data['access']}")
    return User.objects.get(phone=phone)


def _person_profile(user: User) -> Profile:
    return Profile.objects.create(
        kind=Profile.Kind.PERSON,
        owner_user=user,
        profile_visibility=Profile.Visibility.LINK_AND_DEALS,
    )


def _setup_and_freeze_global_contract(
    customer_phone: str, contractor_phone: str, suffix: str, *, customer_country_code: str
):
    """draft -> under_review -> дерево этапов -> jurisdiction=DE (GLOBAL, официальный
    язык en) -> freeze, через API (тот же путь, что test_signing_api.py).

    `customer_country_code` выставляется СРАЗУ после логина, ДО freeze —
    рендеры считаются на момент заморозки (services._party_locales), locale,
    выставленная ПОСЛЕ, в уже посчитанный набор рендеров не попадёт (честный
    фолбэк на официальный язык, resolve_shown_locale). OTP-логин (`_login`) сам
    по себе проставляет country_code="RU" (apps.accounts.services) — тест
    должен явно решить, что ему нужно, а не полагаться на дефолт логина."""
    customer_client = APIClient()
    customer = _login(customer_client, customer_phone)
    customer.country_code = customer_country_code
    customer.save(update_fields=["country_code"])
    contractor = User.objects.create(trust_id=f"trust-l10n-{suffix}", phone=contractor_phone)
    contractor_profile = _person_profile(contractor)

    resp = customer_client.post(
        "/v1/contracts",
        {
            "client_option": "service",
            "my_role": "customer",
            "counterparty_profile_id": str(contractor_profile.id),
            "payment_method": "cash",
            "payment_order": "after_acceptance",
            "title": "Web design",
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    contract_id = resp.data["id"]

    contractor_client = APIClient()
    _login(contractor_client, contractor_phone)

    resp = customer_client.post(f"/v1/contracts/{contract_id}/send", format="json")
    assert resp.status_code == 200, resp.content

    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/milestones",
        {"title": "Design", "amount": "1000.00", "currency": "RUB"},
        format="json",
    )
    assert resp.status_code == 201, resp.content

    Contract.objects.filter(id=contract_id).update(jurisdiction="DE")

    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/freeze",
        format="json",
        HTTP_IDEMPOTENCY_KEY=f"freeze-l10n-{suffix}",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["official_language"] == "en"

    return (
        customer_client,
        contractor_client,
        contract_id,
        resp.data["id"],
        resp.data["integrity_hash"],
        customer,
        contractor,
    )


def test_sign_response_includes_disclaimer_when_signer_locale_differs_from_official_language():
    _seed_jurisdiction("ES", "es")
    (
        customer_client,
        _contractor_client,
        contract_id,
        version_id,
        integrity_hash,
        customer,
        _contractor,
    ) = _setup_and_freeze_global_contract(
        "+79990890001", "+79990890002", "disc1", customer_country_code="ES"
    )

    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/signature-requests",
        {"side": "customer", "version_id": version_id, "signatory_user_id": str(customer.id)},
        format="json",
        HTTP_IDEMPOTENCY_KEY="route-l10n-disc1",
    )
    assert resp.status_code == 201, resp.content
    request_id = resp.data["id"]

    resp = customer_client.post(
        f"/v1/signature-requests/{request_id}/sign",
        {"version_hash": integrity_hash},
        format="json",
        HTTP_IDEMPOTENCY_KEY="sign-l10n-disc1",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["disclaimer"]["locale"] == "es"
    assert "en" in resp.data["disclaimer"]["text"]
    assert "canonical" not in resp.data["disclaimer"]["text"].lower()

    resp = customer_client.get(f"/v1/contracts/{contract_id}/signature-requests")
    assert resp.data[0]["locale"] == "es"


def test_sign_response_has_no_disclaimer_when_signer_locale_equals_official_language():
    (
        customer_client,
        _contractor_client,
        contract_id,
        version_id,
        integrity_hash,
        customer,
        _contractor,
    ) = _setup_and_freeze_global_contract(
        "+79990890003", "+79990890004", "disc2", customer_country_code="DE"
    )
    # "DE" — без своего JurisdictionConfig -> GLOBAL-дефолт -> "en", совпадает
    # с официальным языком контракта ("en"). OTP-логин сам проставил бы "RU"
    # (apps.accounts.services) — явно перебиваем, чтобы тест не зависел от
    # дефолта логина, а не от намеренного выбора locale.

    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/signature-requests",
        {"side": "customer", "version_id": version_id, "signatory_user_id": str(customer.id)},
        format="json",
        HTTP_IDEMPOTENCY_KEY="route-l10n-disc2",
    )
    assert resp.status_code == 201, resp.content
    request_id = resp.data["id"]

    resp = customer_client.post(
        f"/v1/signature-requests/{request_id}/sign",
        {"version_hash": integrity_hash},
        format="json",
        HTTP_IDEMPOTENCY_KEY="sign-l10n-disc2",
    )
    assert resp.status_code == 200, resp.content
    assert "disclaimer" not in resp.data


# --- PATCH /contracts/{id}: language (API) ----------------------------------


def test_patch_contract_sets_language_and_freeze_honors_it():
    _seed_jurisdiction("ES", "es")
    _seed_locale("es", Locale.Quality.REVIEWED)
    _seed_locale("fr", Locale.Quality.REVIEWED)

    customer_client = APIClient()
    customer = _login(customer_client, "+79990890005")
    customer.country_code = "ES"
    customer.save(update_fields=["country_code"])
    contractor = User.objects.create(trust_id="trust-l10n-patch1", phone="+79990890006")
    contractor.country_code = "ES"
    contractor.save(update_fields=["country_code"])
    contractor_profile = _person_profile(contractor)

    resp = customer_client.post(
        "/v1/contracts",
        {
            "client_option": "service",
            "my_role": "customer",
            "counterparty_profile_id": str(contractor_profile.id),
            "payment_method": "cash",
            "payment_order": "after_acceptance",
            "title": "Design",
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    contract_id = resp.data["id"]

    resp = customer_client.patch(f"/v1/contracts/{contract_id}", {"language": "fr"}, format="json")
    assert resp.status_code == 200, resp.content
    assert resp.data["language"] == "fr"

    resp = customer_client.post(f"/v1/contracts/{contract_id}/send", format="json")
    assert resp.status_code == 200, resp.content
    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/milestones",
        {"title": "Design", "amount": "1000.00", "currency": "RUB"},
        format="json",
    )
    assert resp.status_code == 201, resp.content

    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/freeze",
        format="json",
        HTTP_IDEMPOTENCY_KEY="freeze-l10n-patch1",
    )
    assert resp.status_code == 200, resp.content
    # Стороны делят "es" (reviewed) — но явный override "fr" побеждает.
    assert resp.data["official_language"] == "fr"


def test_patch_contract_rejects_language_below_reviewed_quality():
    _seed_locale("xx", Locale.Quality.MACHINE)

    customer_client = APIClient()
    _login(customer_client, "+79990890007")
    contractor = User.objects.create(trust_id="trust-l10n-patch2", phone="+79990890008")
    contractor_profile = _person_profile(contractor)

    resp = customer_client.post(
        "/v1/contracts",
        {
            "client_option": "service",
            "my_role": "customer",
            "counterparty_profile_id": str(contractor_profile.id),
            "payment_method": "cash",
            "payment_order": "after_acceptance",
            "title": "Design",
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    contract_id = resp.data["id"]

    resp = customer_client.patch(f"/v1/contracts/{contract_id}", {"language": "xx"}, format="json")
    assert resp.status_code == 422, resp.content
    assert resp.data["code"] == "language_not_eligible"
