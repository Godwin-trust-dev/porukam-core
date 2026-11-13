"""docs/tasks/etap-3.md 3.3 + docs/tasks/etap-3-delta-adr059.md (дельта
первична). Обязательные тесты дельты §2 помечены явно в докстринге теста."""

from __future__ import annotations

import pytest

from apps.accounts.models import User
from apps.social import hashing, selectors, services
from apps.social.models import (
    AddressableGroup,
    Consent,
    Contact,
    GroupMembership,
    Handle,
    PhonebookHash,
)

pytestmark = pytest.mark.django_db


@pytest.fixture
def user() -> User:
    return User.objects.create(trust_id="trust-social-svc-1", phone="+79990810001")


@pytest.fixture
def other() -> User:
    return User.objects.create(trust_id="trust-social-svc-2", phone="+79990810002")


# --- claim_handle --------------------------------------------------------


def test_claim_handle_normalizes_case_and_at(user: User):
    handle = services.claim_handle(user=user, value="@Ivan_Master")
    assert handle.value == "ivan_master"


def test_claim_handle_rejects_invalid_format(user: User):
    with pytest.raises(services.InvalidHandleFormatError):
        services.claim_handle(user=user, value="a!")


def test_claim_handle_rejects_taken_value(user: User, other: User):
    services.claim_handle(user=user, value="taken")
    with pytest.raises(services.HandleTakenError):
        services.claim_handle(user=other, value="taken")


def test_claim_handle_change_releases_previous(user: User, other: User):
    services.claim_handle(user=user, value="old_name")
    services.claim_handle(user=user, value="new_name")

    # старый освободился и доступен другому
    handle = services.claim_handle(user=other, value="old_name")
    assert handle.value == "old_name"
    assert Handle.objects.filter(value="new_name", user=user, is_active=True).exists()
    assert not Handle.objects.filter(value="old_name", user=user, is_active=True).exists()


# --- contacts --------------------------------------------------------------


def test_list_contacts_only_own(user: User, other: User):
    services.add_contact(user, target_user=other, source=Contact.Source.MANUAL)
    services.add_contact(other, target_user=user, source=Contact.Source.MANUAL)

    assert selectors.list_contacts(user).count() == 1
    assert selectors.get_contact_or_404(user, selectors.list_contacts(user).first().id)


def test_get_contact_or_404_for_someone_elses_contact_raises_404(user: User, other: User):
    from django.http import Http404

    contact = services.add_contact(other, target_user=user, source=Contact.Source.MANUAL)
    with pytest.raises(Http404):
        selectors.get_contact_or_404(user, contact.id)


def test_remove_contact_deletes_row(user: User, other: User):
    contact = services.add_contact(user, target_user=other, source=Contact.Source.MANUAL)
    services.remove_contact(contact)
    assert not Contact.objects.filter(pk=contact.pk).exists()


# --- phonebook reconciliation (etap-3-delta-adr059.md §2) ------------------


def test_reconcile_phonebook_rejects_raw_number(user: User):
    with pytest.raises(services.InvalidPhonebookHashError):
        services.reconcile_phonebook(
            user, hashes=["+79990000000"], algorithm=hashing.ALGORITHM, salt_ref=hashing.SALT_REF
        )


def test_reconcile_phonebook_rejects_unsupported_algorithm(user: User):
    good_hash = hashing.phone_hash("+79990810099")
    with pytest.raises(services.InvalidPhonebookHashError):
        services.reconcile_phonebook(user, hashes=[good_hash], algorithm="md5", salt_ref="whatever")


def test_reconcile_phonebook_finds_discoverable_match(user: User, other: User):
    other.discoverable_by_phone = True
    other.save(update_fields=["discoverable_by_phone"])

    matches = services.reconcile_phonebook(
        user,
        hashes=[hashing.phone_hash(other.phone)],
        algorithm=hashing.ALGORITHM,
        salt_ref=hashing.SALT_REF,
    )
    assert matches == [other]
    assert Contact.objects.filter(
        owner=user, target_user=other, source=Contact.Source.PHONEBOOK
    ).exists()


def test_reconcile_phonebook_excludes_non_discoverable_match(user: User, other: User):
    """Дельта §2 тест 1: пользователь, выбравший «не разрешать» находимость,
    не находится по хешу даже при совпадении номера."""
    other.discoverable_by_phone = False
    other.save(update_fields=["discoverable_by_phone"])

    matches = services.reconcile_phonebook(
        user,
        hashes=[hashing.phone_hash(other.phone)],
        algorithm=hashing.ALGORITHM,
        salt_ref=hashing.SALT_REF,
    )
    assert matches == []
    assert not Contact.objects.filter(owner=user, target_user=other).exists()


def test_reconcile_phonebook_deletes_unmatched_hashes(user: User):
    """Дельта §2 тест 3: после сверки в таблице хешей не остаётся хешей,
    не принадлежащих согласившемуся пользователю (тут — вообще никому)."""
    services.reconcile_phonebook(
        user,
        hashes=[hashing.phone_hash("+79990000099")],
        algorithm=hashing.ALGORITHM,
        salt_ref=hashing.SALT_REF,
    )
    assert PhonebookHash.objects.filter(user=user).count() == 0


def test_reconcile_phonebook_removes_hash_when_consent_later_revoked(user: User, other: User):
    """Дельта §2 тест 3 (продолжение): повторная сверка после отзыва
    находимости чистит ранее сохранённый совпавший хеш."""
    other.discoverable_by_phone = True
    other.save(update_fields=["discoverable_by_phone"])
    services.reconcile_phonebook(
        user,
        hashes=[hashing.phone_hash(other.phone)],
        algorithm=hashing.ALGORITHM,
        salt_ref=hashing.SALT_REF,
    )
    assert PhonebookHash.objects.filter(user=user).count() == 1

    other.discoverable_by_phone = False
    other.save(update_fields=["discoverable_by_phone"])
    services.reconcile_phonebook(
        user,
        hashes=[hashing.phone_hash(other.phone)],
        algorithm=hashing.ALGORITHM,
        salt_ref=hashing.SALT_REF,
    )
    assert PhonebookHash.objects.filter(user=user).count() == 0


def test_reconcile_phonebook_sets_mutual_when_reverse_contact_exists(user: User, other: User):
    other.discoverable_by_phone = True
    other.save(update_fields=["discoverable_by_phone"])
    services.add_contact(other, target_user=user, source=Contact.Source.MANUAL)

    services.reconcile_phonebook(
        user,
        hashes=[hashing.phone_hash(other.phone)],
        algorithm=hashing.ALGORITHM,
        salt_ref=hashing.SALT_REF,
    )

    assert Contact.objects.get(owner=user, target_user=other).is_mutual
    assert Contact.objects.get(owner=other, target_user=user).is_mutual


# --- consents / privacy step (etap-3-delta-adr059.md §2 тест 2) ------------


def test_is_privacy_step_complete_false_until_all_three(user: User):
    assert selectors.is_privacy_step_complete(user) is False
    services.record_consent(user, consent_type=Consent.ConsentType.PD_PROCESSING, value=True)
    assert selectors.is_privacy_step_complete(user) is False
    services.record_consent(user, consent_type=Consent.ConsentType.PROFILE_PUBLIC, value=True)
    assert selectors.is_privacy_step_complete(user) is False
    services.record_consent(
        user, consent_type=Consent.ConsentType.PHONE_DISCOVERABILITY, value=False
    )
    assert selectors.is_privacy_step_complete(user) is True


def test_complete_privacy_step_requires_pd_processing_true(user: User):
    """Дельта §2 тест 2: регистрация не завершается без явного (и
    положительного, для pd_processing) выбора по всем трём согласиям."""
    with pytest.raises(services.PdProcessingConsentRequiredError):
        services.complete_privacy_step(
            user, pd_processing=False, profile_public=True, phone_discoverability=True
        )
    assert selectors.is_privacy_step_complete(user) is False


def test_complete_privacy_step_records_all_three_with_text_version(user: User):
    consents = services.complete_privacy_step(
        user, pd_processing=True, profile_public=False, phone_discoverability=True
    )
    assert {c.consent_type for c in consents} == {
        Consent.ConsentType.PD_PROCESSING,
        Consent.ConsentType.PROFILE_PUBLIC,
        Consent.ConsentType.PHONE_DISCOVERABILITY,
    }
    assert all(c.text_version for c in consents)
    assert selectors.is_privacy_step_complete(user) is True


def test_complete_privacy_step_sets_discoverable_by_phone(user: User):
    assert user.discoverable_by_phone is None
    services.complete_privacy_step(
        user, pd_processing=True, profile_public=True, phone_discoverability=True
    )
    user.refresh_from_db()
    assert user.discoverable_by_phone is True


def test_record_consent_is_append_only_history(user: User):
    services.record_consent(user, consent_type=Consent.ConsentType.PROFILE_PUBLIC, value=True)
    services.record_consent(user, consent_type=Consent.ConsentType.PROFILE_PUBLIC, value=False)
    assert (
        Consent.objects.filter(user=user, consent_type=Consent.ConsentType.PROFILE_PUBLIC).count()
        == 2
    )
    latest = selectors.latest_consents(user)[Consent.ConsentType.PROFILE_PUBLIC]
    assert latest.value is False


# --- locale (Л.2 п.5, docs/tasks/l10n-wave.md, ADR-077) --------------------


def test_record_consent_defaults_locale_to_ru(user: User):
    consent = services.record_consent(
        user, consent_type=Consent.ConsentType.PD_PROCESSING, value=True
    )
    assert consent.locale == "ru"


def test_record_consent_stores_locale_and_version_for_non_default_language(user: User):
    """✅ приёмка Л.2: Consent, данное на es, хранит locale+версию (версия —
    по существующему фолбэку settings.CONSENT_TEXT_VERSIONS, es там пока
    нет — RU-версия как ближайший доступный текст, не ошибка)."""
    consent = services.record_consent(
        user, consent_type=Consent.ConsentType.PD_PROCESSING, value=True, locale="es"
    )
    assert consent.locale == "es"
    assert consent.text_version == "v1"


def test_complete_global_privacy_step_records_en_locale(user: User):
    consents = services.complete_global_privacy_step(
        user,
        pd_processing=True,
        profile_public=True,
        phone_discoverability=True,
        reputation_history_basis=True,
    )
    assert all(c.locale == "en" for c in consents)


# --- groups ------------------------------------------------------------


def test_create_group_makes_leader_active_member(user: User):
    group = services.create_group(
        user,
        kind=AddressableGroup.Kind.COMMUNITY,
        name="Мастера ремонта",
        handle="masters_remont",
        sphere_code="it",
    )
    membership = GroupMembership.objects.get(group=group, member=user)
    assert membership.role == GroupMembership.Role.LEADER
    assert membership.status == GroupMembership.Status.ACTIVE


def test_member_cannot_manage_group(user: User, other: User):
    group = services.create_group(
        user, kind=AddressableGroup.Kind.COMMUNITY, name="G", handle="grp_a", sphere_code="it"
    )
    services.invite_member(group, user, other, role=GroupMembership.Role.MEMBER)
    services.update_membership(
        group,
        user,
        GroupMembership.objects.get(group=group, member=other),
        status=GroupMembership.Status.ACTIVE,
    )

    with pytest.raises(services.GroupPermissionDeniedError):
        services.update_group(group, other, name="перехват")


def test_admin_can_manage_group(user: User, other: User):
    group = services.create_group(
        user, kind=AddressableGroup.Kind.COMMUNITY, name="G", handle="grp_b", sphere_code="it"
    )
    services.invite_member(group, user, other, role=GroupMembership.Role.ADMIN)
    services.update_membership(
        group,
        user,
        GroupMembership.objects.get(group=group, member=other),
        status=GroupMembership.Status.ACTIVE,
    )
    updated = services.update_group(group, other, name="новое имя")
    assert updated.name == "новое имя"


def test_remove_member_sets_status_left_not_delete(user: User, other: User):
    group = services.create_group(
        user, kind=AddressableGroup.Kind.COMMUNITY, name="G", handle="grp_c", sphere_code="it"
    )
    membership = services.invite_member(group, user, other)
    services.remove_member(group, user, membership)
    membership.refresh_from_db()
    assert membership.status == GroupMembership.Status.LEFT


# --- reputation link -----------------------------------------------------


def test_reputation_link_requires_handle(user: User):
    with pytest.raises(services.HandleRequiredForReputationLinkError):
        services.build_reputation_link(user)


def test_reputation_link_uses_handle_not_trust_id(user: User):
    services.claim_handle(user=user, value="ivan_master")
    url = services.build_reputation_link(user)
    assert url.endswith("/@ivan_master")
    assert user.trust_id not in url


# --- GLOBAL privacy step (ГВ.2, docs/tasks/global-wave.md, ADR-071) --------


def test_is_global_privacy_step_complete_false_until_all_four(user: User):
    assert selectors.is_global_privacy_step_complete(user) is False
    services.record_consent(
        user, consent_type=Consent.ConsentType.PD_PROCESSING, value=True, locale="en"
    )
    services.record_consent(
        user, consent_type=Consent.ConsentType.PROFILE_PUBLIC, value=True, locale="en"
    )
    services.record_consent(
        user, consent_type=Consent.ConsentType.PHONE_DISCOVERABILITY, value=False, locale="en"
    )
    assert selectors.is_global_privacy_step_complete(user) is False
    services.record_consent(
        user, consent_type=Consent.ConsentType.REPUTATION_HISTORY_BASIS, value=True, locale="en"
    )
    assert selectors.is_global_privacy_step_complete(user) is True


def test_complete_global_privacy_step_requires_pd_processing_true(user: User):
    with pytest.raises(services.PdProcessingConsentRequiredError):
        services.complete_global_privacy_step(
            user,
            pd_processing=False,
            profile_public=True,
            phone_discoverability=True,
            reputation_history_basis=True,
        )
    assert selectors.is_global_privacy_step_complete(user) is False


def test_complete_global_privacy_step_records_all_four_as_english(user: User):
    consents = services.complete_global_privacy_step(
        user,
        pd_processing=True,
        profile_public=False,
        phone_discoverability=True,
        reputation_history_basis=False,
    )
    assert {c.consent_type for c in consents} == {
        Consent.ConsentType.PD_PROCESSING,
        Consent.ConsentType.PROFILE_PUBLIC,
        Consent.ConsentType.PHONE_DISCOVERABILITY,
        Consent.ConsentType.REPUTATION_HISTORY_BASIS,
    }
    assert all(c.text_version for c in consents)
    # EN-версии отличаются от RU (settings.CONSENT_TEXT_VERSIONS, ADR-071) —
    # проверяем, что locale реально дошёл до text_version, а не тихо
    # выпал в RU-дефолт.
    ru_version = services._consent_text_version(Consent.ConsentType.PD_PROCESSING)
    en_consent = next(c for c in consents if c.consent_type == Consent.ConsentType.PD_PROCESSING)
    assert en_consent.text_version != ru_version
    assert selectors.is_global_privacy_step_complete(user) is True


def test_complete_global_privacy_step_sets_discoverable_by_phone(user: User):
    assert user.discoverable_by_phone is None
    services.complete_global_privacy_step(
        user,
        pd_processing=True,
        profile_public=True,
        phone_discoverability=True,
        reputation_history_basis=True,
    )
    user.refresh_from_db()
    assert user.discoverable_by_phone is True


def test_ru_privacy_step_unaffected_by_global_wave_locale_change(user: User):
    """✅ ГВ.2: OTP-флоу/RU-регистрация не сломаны — три исходных согласия
    остаются RU-версией по умолчанию, без изменений в вызове."""
    consents = services.complete_privacy_step(
        user, pd_processing=True, profile_public=True, phone_discoverability=True
    )
    assert {c.consent_type for c in consents} == {
        Consent.ConsentType.PD_PROCESSING,
        Consent.ConsentType.PROFILE_PUBLIC,
        Consent.ConsentType.PHONE_DISCOVERABILITY,
    }
    for consent in consents:
        assert consent.text_version == services._consent_text_version(consent.consent_type)


# --- search_handles (префикс-поиск контрагента, GET /v1/handles?q=) -------


@pytest.fixture
def searcher() -> User:
    return User.objects.create(trust_id="trust-social-search-me", phone="+79990811000")


def _with_handle(*, trust_id: str, phone: str, handle: str, **fields: object) -> User:
    user = User.objects.create(trust_id=trust_id, phone=phone, **fields)
    services.claim_handle(user=user, value=handle)
    return user


def test_search_handles_matches_prefix_only(searcher: User):
    _with_handle(trust_id="t-s-1", phone="+79990811001", handle="ivan_master")
    _with_handle(trust_id="t-s-2", phone="+79990811002", handle="master_ivan")

    found = selectors.search_handles(prefix="ivan", viewer=searcher)

    # «master_ivan» содержит «ivan», но не НАЧИНАЕТСЯ с него — это префикс-поиск,
    # не подстрока и не полнотекст.
    assert [h.value for h in found] == ["ivan_master"]


def test_search_handles_is_case_insensitive_and_strips_at(searcher: User):
    _with_handle(trust_id="t-s-3", phone="+79990811003", handle="ivan_master")

    assert [h.value for h in selectors.search_handles(prefix="IVA", viewer=searcher)] == [
        "ivan_master"
    ]
    assert [h.value for h in selectors.search_handles(prefix="@Iva", viewer=searcher)] == [
        "ivan_master"
    ]
    assert [h.value for h in selectors.search_handles(prefix="  iva  ", viewer=searcher)] == [
        "ivan_master"
    ]


def test_search_handles_excludes_self(searcher: User):
    services.claim_handle(user=searcher, value="ivan_self")
    _with_handle(trust_id="t-s-4", phone="+79990811004", handle="ivan_other")

    found = selectors.search_handles(prefix="ivan", viewer=searcher)

    # Себя контрагентом выбрать нельзя — своего хендла в выдаче нет вовсе.
    assert [h.value for h in found] == ["ivan_other"]


def test_search_handles_excludes_groups(searcher: User):
    leader = User.objects.create(trust_id="t-s-5", phone="+79990811005")
    group = AddressableGroup.objects.create(
        kind=AddressableGroup.Kind.COMMUNITY, leader=leader, name="Мастера"
    )
    services.claim_handle(group=group, value="ivan_group")

    # AddressableGroup — витрина, НЕ сторона договора (tech-spec.md §5.2.1b).
    assert selectors.search_handles(prefix="ivan", viewer=searcher) == []


def test_search_handles_excludes_not_discoverable_by_handle(searcher: User):
    _with_handle(
        trust_id="t-s-6",
        phone="+79990811006",
        handle="ivan_hidden",
        discoverable_by_handle=False,
    )

    assert selectors.search_handles(prefix="ivan", viewer=searcher) == []


def test_search_handles_excludes_banned_and_inactive_users(searcher: User):
    _with_handle(trust_id="t-s-7", phone="+79990811007", handle="ivan_banned", is_banned=True)
    _with_handle(trust_id="t-s-8", phone="+79990811008", handle="ivan_gone", is_active=False)

    assert selectors.search_handles(prefix="ivan", viewer=searcher) == []


def test_search_handles_ignores_released_handles(searcher: User):
    user = _with_handle(trust_id="t-s-9", phone="+79990811009", handle="ivan_old")
    services.claim_handle(user=user, value="ivan_new")

    # Старый хендл остаётся строкой истории (is_active=False) — но не находится.
    assert Handle.objects.filter(user=user).count() == 2
    assert [h.value for h in selectors.search_handles(prefix="ivan", viewer=searcher)] == [
        "ivan_new"
    ]


def test_search_handles_short_prefix_returns_empty(searcher: User):
    _with_handle(trust_id="t-s-10", phone="+79990811010", handle="ivan_master")

    assert selectors.search_handles(prefix="", viewer=searcher) == []
    assert selectors.search_handles(prefix="@", viewer=searcher) == []
    assert selectors.search_handles(prefix="i", viewer=searcher) == []


def test_search_handles_applies_limit_and_caps_it(searcher: User):
    for ix in range(7):
        _with_handle(trust_id=f"t-s-lim-{ix}", phone=f"+7999081200{ix}", handle=f"ivan_lim_{ix}")

    assert len(selectors.search_handles(prefix="ivan", viewer=searcher, limit=3)) == 3
    # Потолок (HANDLE_SEARCH_MAX_LIMIT) не даёт клиенту выкачать справочник.
    assert len(selectors.search_handles(prefix="ivan", viewer=searcher, limit=10_000)) == 7
    assert selectors.HANDLE_SEARCH_MAX_LIMIT == 50


def test_search_handles_is_ordered_by_value(searcher: User):
    _with_handle(trust_id="t-s-ord-1", phone="+79990813001", handle="ivan_b")
    _with_handle(trust_id="t-s-ord-2", phone="+79990813002", handle="ivan_a")

    found = selectors.search_handles(prefix="ivan", viewer=searcher)

    assert [h.value for h in found] == ["ivan_a", "ivan_b"]
