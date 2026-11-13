"""DELETE /v1/users/me — удаление аккаунта пользователем (ADR-169).

Каждый запрет — отдельным тестом (CLAUDE.md): удерживающие основания
параметризованы по КАЖДОМУ статусу договора и спора, отдельно проверено, что
черновик и завершённые статусы НЕ удерживают.
"""

from __future__ import annotations

import re

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts import selectors as accounts_selectors
from apps.accounts import services
from apps.accounts.api.views import _sms_gateway
from apps.accounts.models import DeviceKey, SocialLoginAccount, User, UserDevice
from apps.contracts.models import Contract, ContractParty
from apps.disputes.models import Dispute
from apps.notifications.models import PushSubscription
from apps.profiles import selectors as profiles_selectors
from apps.profiles import services as profiles_services
from apps.profiles.models import Portfolio, PortfolioPhoto, PortfolioProject, Profile
from apps.profiles.storage import build_avatar_store
from apps.social.models import Contact, Handle, PhonebookHash
from common.crypto import SubjectKeyDestroyedError, decrypt_for_subject, encrypt_for_subject
from common.models import OutboxEvent, SubjectKey

pytestmark = pytest.mark.django_db(databases=["default", "audit"])


# --- вспомогательное ------------------------------------------------------


def _code_for(phone: str) -> str:
    for sent_phone, message in reversed(_sms_gateway.sent):
        if sent_phone == phone:
            match = re.search(r"\d{6}", message)
            assert match
            return match.group()
    raise AssertionError(f"код для {phone} не отправлялся")


def _login(client: APIClient, phone: str) -> dict:
    resp = client.post("/v1/auth/otp/request", {"phone": phone}, format="json")
    assert resp.status_code == 200, resp.content
    resp = client.post(
        "/v1/auth/otp/verify", {"phone": phone, "code": _code_for(phone)}, format="json"
    )
    assert resp.status_code == 200, resp.content
    return dict(resp.data)


def _authed(phone: str) -> tuple[APIClient, User, dict]:
    client = APIClient()
    tokens = _login(client, phone)
    user = User.objects.get(phone=phone)
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")
    return client, user, tokens


def _person_profile(user: User) -> Profile:
    return Profile.objects.create(
        kind=Profile.Kind.PERSON,
        owner_user=user,
        profile_visibility=Profile.Visibility.LINK_AND_DEALS,
    )


def _contract_with(
    user: User,
    *,
    negotiation_status: str,
    execution_status: str | None = None,
    created_by: User | None = None,
) -> Contract:
    """Договор, где `user` — исполнитель через свой person-профиль."""
    contract = Contract.objects.create(
        contract_type_id="services_individual",
        deal_type=Contract.DealType.C2C,
        segment="free_c2c",
        jurisdiction="RU",
        created_by=created_by or user,
        negotiation_status=negotiation_status,
        execution_status=execution_status,
    )
    ContractParty.objects.create(
        contract=contract,
        role=ContractParty.Role.CONTRACTOR,
        profile=_person_profile(user),
        acting_as=ContractParty.ActingAs.PERSON,
    )
    return contract


# --- счастливый путь ------------------------------------------------------


def test_delete_me_returns_202_with_deleted_at():
    client, user, _tokens = _authed("+79990860001")

    resp = client.delete("/v1/users/me")

    assert resp.status_code == 202, resp.content
    assert "deleted_at" in resp.data
    user.refresh_from_db()
    assert user.deleted_at is not None
    assert user.is_active is False
    # trust_id необратим и остаётся (tech-spec.md §10.2).
    assert user.trust_id


def test_deletion_nulls_unique_contacts_but_keeps_trust_id():
    client, user, _tokens = _authed("+79990860002")
    services.update_profile(user, email="gone@example.com", full_name="Иван Иванов")

    client.delete("/v1/users/me")

    user.refresh_from_db()
    assert user.phone is None
    assert user.email is None
    assert user.email_verified_at is None
    assert user.full_name_encrypted is None
    assert user.encryption_key_ref is None
    assert user.discoverable_by_phone is False
    assert user.discoverable_by_handle is False


def test_full_name_not_decryptable_after_deletion():
    """Crypto-shredding: ключ субъекта уничтожен, шифртекст (где бы он ни
    остался) больше не расшифровывается."""
    client, user, _tokens = _authed("+79990860003")
    services.update_profile(user, full_name="Пётр Петров")
    ciphertext = bytes(user.full_name_encrypted or b"")
    key_ref = user.encryption_key_ref or ""
    assert decrypt_for_subject(ciphertext, key_ref) == "Пётр Петров"

    client.delete("/v1/users/me")

    assert SubjectKey.objects.get(subject_type="user", subject_id=str(user.id)).destroyed_at
    with pytest.raises(SubjectKeyDestroyedError):
        decrypt_for_subject(ciphertext, key_ref)
    user.refresh_from_db()
    assert accounts_selectors.get_full_name(user) is None


def test_account_deleted_event_published_without_personal_data():
    client, user, _tokens = _authed("+79990860004")
    services.update_profile(user, email="event@example.com", full_name="Имя Событие")

    client.delete("/v1/users/me")

    event = OutboxEvent.objects.get(topic="account.deleted")
    assert event.subject == {"type": "user", "id": str(user.id)}
    assert event.payload == {"holds_checked": True}
    serialized = str(event.payload) + str(event.subject) + str(event.actor)
    assert "event@example.com" not in serialized
    assert "Имя Событие" not in serialized


# --- сессии ---------------------------------------------------------------


def test_access_token_rejected_after_deletion():
    client, _user, _tokens = _authed("+79990860005")
    assert client.get("/v1/users/me").status_code == 200

    client.delete("/v1/users/me")

    resp = client.get("/v1/users/me")
    assert resp.status_code == 401


def test_repeated_delete_with_same_token_returns_401():
    client, _user, _tokens = _authed("+79990860006")
    assert client.delete("/v1/users/me").status_code == 202

    assert client.delete("/v1/users/me").status_code == 401


def test_refresh_token_revoked_after_deletion():
    client, _user, tokens = _authed("+79990860007")

    client.delete("/v1/users/me")

    anonymous = APIClient()
    resp = anonymous.post("/v1/auth/token/refresh", {"refresh": tokens["refresh"]}, format="json")
    assert resp.status_code == 401
    assert resp.data["code"] == "refresh_token_invalid"


def test_delete_without_token_returns_401():
    resp = APIClient().delete("/v1/users/me")
    assert resp.status_code == 401


# --- повторный вход тем же контактом --------------------------------------


def test_phone_login_after_deletion_creates_new_account():
    """Номер освобождён (`phone=None`), поэтому вход тем же телефоном — это
    РЕГИСТРАЦИЯ нового пользователя, а не возврат в старый: восстановление
    невозможно by design (tech-spec.md §10.2)."""
    client, deleted, _tokens = _authed("+79990860008")
    client.delete("/v1/users/me")

    fresh_client, fresh_user, _fresh_tokens = _authed("+79990860008")

    assert fresh_user.pk != deleted.pk
    assert fresh_client.get("/v1/users/me").status_code == 200
    deleted.refresh_from_db()
    assert deleted.is_active is False


def test_email_login_after_deletion_creates_new_account(settings):
    """Адрес тоже освобождён — unique-конфликта нет, входит НОВЫЙ аккаунт."""
    settings.OTP_FIXED_CODE = "111111"
    client, deleted, _tokens = _authed("+79990860009")
    services.update_profile(deleted, email="reused@example.com")
    client.delete("/v1/users/me")

    anonymous = APIClient()
    assert (
        anonymous.post(
            "/v1/auth/email/request", {"email": "reused@example.com"}, format="json"
        ).status_code
        == 200
    )
    resp = anonymous.post(
        "/v1/auth/email/verify",
        {"email": "reused@example.com", "code": "111111"},
        format="json",
    )

    assert resp.status_code == 200, resp.content
    fresh = User.objects.get(email="reused@example.com")
    assert fresh.pk != deleted.pk


# --- устройства, связки, ПД других приложений -----------------------------


def test_devices_links_and_push_subscriptions_removed():
    client, user, _tokens = _authed("+79990860010")
    services.register_device(user, platform=UserDevice.Platform.WEB, push_token="tok-1")
    SocialLoginAccount.objects.create(user=user, provider="google", sub="sub-deletion-1")
    PushSubscription.objects.create(
        user=user, endpoint="https://push.example/e1", p256dh="p", auth="a", user_agent="UA"
    )

    client.delete("/v1/users/me")

    assert not UserDevice.objects.filter(user=user).exists()
    assert not SocialLoginAccount.objects.filter(user=user).exists()
    assert not PushSubscription.objects.filter(user=user).exists()


def test_device_with_registered_key_survives_but_push_token_cleared():
    """`Evidence.device_key` — PROTECT (доказательная база): ключ ОТЗЫВАЕТСЯ,
    а не удаляется, поэтому и его устройство остаётся — но без push-токена."""
    client, user, _tokens = _authed("+79990860011")
    device = services.register_device(user, platform=UserDevice.Platform.ANDROID, push_token="tok")
    services.register_device_key(user, device.pk, public_key=b"pub", algorithm="ed25519")

    client.delete("/v1/users/me")

    device.refresh_from_db()
    assert device.push_token == ""
    key = DeviceKey.objects.get(user=user)
    assert key.revoked_at is not None


def test_contacts_phonebook_and_handle_purged():
    client, user, _tokens = _authed("+79990860012")
    encrypted = encrypt_for_subject("Сосед", subject_type="user", subject_id=user.id)
    Contact.objects.create(
        owner=user,
        target_phone_hash="a" * 64,
        source=Contact.Source.MANUAL,
        display_name_encrypted=encrypted.ciphertext,
        encryption_key_ref=encrypted.key_ref,
    )
    PhonebookHash.objects.create(user=user, phone_hash="b" * 64, algorithm="sha256", salt_ref="s1")
    Handle.objects.create(user=user, value="deleteme")

    client.delete("/v1/users/me")

    assert not Contact.objects.filter(owner=user).exists()
    assert not PhonebookHash.objects.filter(user=user).exists()
    assert Handle.objects.get(user=user).is_active is False


def test_profile_avatar_and_portfolio_purged():
    client, user, _tokens = _authed("+79990860013")
    profile = _person_profile(user)
    profile.city_name = "Москва"
    profile.sphere_codes = ["it"]
    profile.avatar_key = f"avatars/{profile.id}/one"
    profile.avatar_source = Profile.AvatarSource.UPLOAD
    profile.save()
    store = build_avatar_store()
    store.put(
        profiles_services.avatar_object_key(profile.avatar_key, 256),
        b"x",
        content_type="image/webp",
    )
    portfolio = Portfolio.objects.create(profile=profile)
    project = PortfolioProject.objects.create(
        portfolio=portfolio,
        title="Секретный проект",
        sphere=PortfolioProject.Sphere.IT,
        photo_key=f"portfolio/{profile.id}/one",
    )
    PortfolioPhoto.objects.create(project=project, photo_key=f"portfolio/{profile.id}/one")
    store.put(
        profiles_services.portfolio_object_key(project.photo_key, 1280),
        b"y",
        content_type="image/webp",
    )

    client.delete("/v1/users/me")

    profile.refresh_from_db()
    assert profile.avatar_key == ""
    assert profile.city_name == ""
    assert profile.sphere_codes == []
    assert profile.hide_from_catalog is True
    assert profile.show_name is False
    assert not PortfolioProject.objects.filter(portfolio=portfolio).exists()
    assert store.get(profiles_services.avatar_object_key(f"avatars/{profile.id}/one", 256)) is None
    assert (
        store.get(profiles_services.portfolio_object_key(f"portfolio/{profile.id}/one", 1280))
        is None
    )


# --- удерживающие основания: договоры -------------------------------------


@pytest.mark.parametrize(
    ("negotiation_status", "phone"),
    [
        (Contract.NegotiationStatus.UNDER_REVIEW, "+79990862001"),
        (Contract.NegotiationStatus.PENDING_SIGNATURE, "+79990862002"),
        (Contract.NegotiationStatus.AWAITING_SIGNATURES, "+79990862003"),
    ],
)
def test_active_negotiation_blocks_deletion(negotiation_status, phone):
    client, user, _tokens = _authed(phone)
    _contract_with(user, negotiation_status=negotiation_status)

    resp = client.delete("/v1/users/me")

    assert resp.status_code == 409
    assert resp["Content-Type"].startswith("application/problem+json")
    assert resp.data["code"] == "account_deletion_blocked"
    assert resp.data["context"]["active_contracts"] == 1
    assert resp.data["context"]["open_disputes"] == 0
    user.refresh_from_db()
    assert user.deleted_at is None
    assert user.is_active is True


@pytest.mark.parametrize(
    ("execution_status", "phone"),
    [
        (Contract.ExecutionStatus.PENDING_START, "+79990863001"),
        (Contract.ExecutionStatus.IN_PROGRESS, "+79990863002"),
        (Contract.ExecutionStatus.WARRANTY, "+79990863003"),
        # Подписан, но статус исполнения ещё не проставлен — тоже живой.
        (None, "+79990863004"),
    ],
)
def test_active_execution_blocks_deletion(execution_status, phone):
    client, user, _tokens = _authed(phone)
    _contract_with(
        user,
        negotiation_status=Contract.NegotiationStatus.SIGNED,
        execution_status=execution_status,
    )

    resp = client.delete("/v1/users/me")

    assert resp.status_code == 409
    assert resp.data["context"]["active_contracts"] == 1


def test_draft_does_not_block_deletion():
    """Черновик односторонен и юридически ничего не значит — удерживать
    удаление он не вправе (ADR-169)."""
    client, user, _tokens = _authed("+79990860014")
    _contract_with(user, negotiation_status=Contract.NegotiationStatus.DRAFT)

    assert client.delete("/v1/users/me").status_code == 202


@pytest.mark.parametrize(
    ("negotiation_status", "execution_status", "phone"),
    [
        (Contract.NegotiationStatus.REJECTED_BY_COUNTERPARTY, None, "+79990864001"),
        (Contract.NegotiationStatus.WITHDRAWN_BY_INITIATOR, None, "+79990864002"),
        (Contract.NegotiationStatus.SIGNED, Contract.ExecutionStatus.COMPLETED, "+79990864003"),
        (Contract.NegotiationStatus.SIGNED, Contract.ExecutionStatus.CLOSED, "+79990864004"),
        (
            Contract.NegotiationStatus.SIGNED,
            Contract.ExecutionStatus.TERMINATED_BY_CUSTOMER,
            "+79990864005",
        ),
        (
            Contract.NegotiationStatus.SIGNED,
            Contract.ExecutionStatus.TERMINATED_BY_CONTRACTOR,
            "+79990864006",
        ),
    ],
)
def test_finished_contract_does_not_block_deletion(negotiation_status, execution_status, phone):
    client, user, _tokens = _authed(phone)
    _contract_with(user, negotiation_status=negotiation_status, execution_status=execution_status)

    assert client.delete("/v1/users/me").status_code == 202


def test_someone_elses_active_contract_does_not_block_deletion():
    client, user, _tokens = _authed("+79990860015")
    _other_client, other, _other_tokens = _authed("+79990860016")
    _contract_with(other, negotiation_status=Contract.NegotiationStatus.UNDER_REVIEW)
    _person_profile(user)

    assert client.delete("/v1/users/me").status_code == 202


# --- удерживающие основания: споры ----------------------------------------


@pytest.mark.parametrize(
    ("status", "phone"),
    [
        (Dispute.Status.OPEN, "+79990865001"),
        (Dispute.Status.AWAITING_FIX, "+79990865002"),
        (Dispute.Status.AWAITING_DISCOUNT, "+79990865003"),
    ],
)
def test_open_dispute_blocks_deletion(status, phone):
    client, user, _tokens = _authed(phone)
    contract = _contract_with(
        user,
        negotiation_status=Contract.NegotiationStatus.SIGNED,
        execution_status=Contract.ExecutionStatus.COMPLETED,
    )
    Dispute.objects.create(
        kind=Dispute.Kind.WARRANTY, contract=contract, opened_by=user, status=status
    )

    resp = client.delete("/v1/users/me")

    assert resp.status_code == 409
    assert resp.data["code"] == "account_deletion_blocked"
    assert resp.data["context"]["open_disputes"] == 1
    assert resp.data["context"]["active_contracts"] == 0


def test_resolved_dispute_does_not_block_deletion():
    client, user, _tokens = _authed("+79990860017")
    contract = _contract_with(
        user,
        negotiation_status=Contract.NegotiationStatus.SIGNED,
        execution_status=Contract.ExecutionStatus.CLOSED,
    )
    Dispute.objects.create(
        kind=Dispute.Kind.WARRANTY,
        contract=contract,
        opened_by=user,
        status=Dispute.Status.RESOLVED,
        outcome=Dispute.Outcome.RESOLVED,
        resolved_at=timezone.now(),
    )

    assert client.delete("/v1/users/me").status_code == 202


# --- чужие экраны ---------------------------------------------------------


def test_counterparty_still_opens_shared_contract_after_deletion():
    """Обязательный тест: карточка договора у ВТОРОЙ стороны не падает 500,
    имя удалённого просто исчезает (`None` — тот же ответ, что у скрытого
    имени; фронт показывает существующий плейсхолдер)."""
    deleted_client, deleted_user, _deleted_tokens = _authed("+79990860018")
    services.update_profile(deleted_user, full_name="Удаляемый Пользователь")
    other_client, other_user, _other_tokens = _authed("+79990860019")

    contract = Contract.objects.create(
        contract_type_id="services_individual",
        deal_type=Contract.DealType.C2C,
        segment="free_c2c",
        jurisdiction="RU",
        created_by=other_user,
        negotiation_status=Contract.NegotiationStatus.SIGNED,
        execution_status=Contract.ExecutionStatus.CLOSED,
    )
    deleted_profile = _person_profile(deleted_user)
    ContractParty.objects.create(
        contract=contract,
        role=ContractParty.Role.CONTRACTOR,
        profile=deleted_profile,
        acting_as=ContractParty.ActingAs.PERSON,
    )
    ContractParty.objects.create(
        contract=contract,
        role=ContractParty.Role.CUSTOMER,
        profile=_person_profile(other_user),
        acting_as=ContractParty.ActingAs.PERSON,
    )

    assert deleted_client.delete("/v1/users/me").status_code == 202

    resp = other_client.get(f"/v1/contracts/{contract.id}")
    assert resp.status_code == 200, resp.content
    deleted_profile.refresh_from_db()
    assert profiles_selectors.public_display_name(deleted_profile) is None
