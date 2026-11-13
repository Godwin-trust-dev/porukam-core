"""apps.milestones.api — Э4.6 приёмка (docs/tasks/etap-4.md, ФИНАЛЬНАЯ
приёмка всего Э4): сквозной сценарий через Swagger-эквивалент (APIClient)
— «Услуга» free_c2c: черновик -> дерево -> заморозка -> две подписи ->
гейт (cash) -> сдача с файлом -> таймер приёмки в /acceptance -> явная
приёмка -> paid (подтверждение-заглушка) -> completed. Вся история — в
timeline и Audit Vault; verify_chain целостна."""

from __future__ import annotations

import re
from datetime import timedelta

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts import services as accounts_services
from apps.accounts.api.views import _sms_gateway
from apps.accounts.models import User
from apps.deadlines import tasks as deadlines_tasks
from apps.deadlines.models import DomainDeadline
from apps.profiles.models import Profile
from common import relay
from services.audit_vault import api as audit_vault_api

pytestmark = pytest.mark.django_db(databases=["default", "audit"])


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


def test_full_execution_path_free_c2c_services_individual_reaches_completed():
    customer_client = APIClient()
    customer = _login(customer_client, "+79990890001")
    contractor_client = APIClient()
    contractor = _login(contractor_client, "+79990890002")
    contractor_profile = _person_profile(contractor)

    # --- черновик (Э4.1) ---
    resp = customer_client.post(
        "/v1/contracts",
        {
            "client_option": "service",
            "my_role": "customer",
            "counterparty_profile_id": str(contractor_profile.id),
            "payment_method": "cash",
            "payment_order": "after_acceptance",
            "title": "Поклейка обоев",
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    contract_id = resp.data["id"]
    assert resp.data["segment"] == "free_c2c"

    # --- дерево этапов (Э4.3) ---
    resp = customer_client.post(f"/v1/contracts/{contract_id}/send", format="json")
    assert resp.status_code == 200, resp.content

    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/milestones",
        {"title": "Обои", "amount": "10000.00", "currency": "RUB"},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    milestone_id = resp.data["id"]

    resp = customer_client.post(
        f"/v1/milestones/{milestone_id}/checklist-items",
        {
            "description": "Обои поклеены без пузырей",
            "measurable_criterion": "Визуальный осмотр, без дефектов на 2м",
            "required_evidence": ["photo"],
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    checklist_item_id = resp.data["id"]

    # --- заморозка + две подписи (Э4.4) ---
    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/freeze", format="json", HTTP_IDEMPOTENCY_KEY="freeze-1"
    )
    assert resp.status_code == 200, resp.content
    version_id = resp.data["id"]
    integrity_hash = resp.data["integrity_hash"]

    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/signature-requests",
        {"side": "customer", "version_id": version_id, "signatory_user_id": str(customer.id)},
        format="json",
        HTTP_IDEMPOTENCY_KEY="route-customer-1",
    )
    assert resp.status_code == 201, resp.content
    customer_request_id = resp.data["id"]

    resp = contractor_client.post(
        f"/v1/contracts/{contract_id}/signature-requests",
        {
            "side": "contractor",
            "version_id": version_id,
            "signatory_user_id": str(contractor.id),
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="route-contractor-1",
    )
    assert resp.status_code == 201, resp.content
    contractor_request_id = resp.data["id"]

    resp = customer_client.post(
        f"/v1/signature-requests/{customer_request_id}/sign",
        {"version_hash": integrity_hash},
        format="json",
        HTTP_IDEMPOTENCY_KEY="sign-customer-1",
    )
    assert resp.status_code == 200, resp.content

    resp = contractor_client.post(
        f"/v1/signature-requests/{contractor_request_id}/sign",
        {"version_hash": integrity_hash},
        format="json",
        HTTP_IDEMPOTENCY_KEY="sign-contractor-1",
    )
    assert resp.status_code == 200, resp.content

    resp = customer_client.get(f"/v1/contracts/{contract_id}")
    assert resp.data["negotiation_status"] == "signed"
    assert resp.data["execution_status"] == "pending_start"

    # --- гейт (cash) — Э4.6 ---
    resp = customer_client.get(f"/v1/milestones/{milestone_id}/gate")
    assert resp.status_code == 200, resp.content
    assert resp.data["can_start"] is True

    resp = customer_client.post(f"/v1/milestones/{milestone_id}/start", format="json")
    assert resp.status_code == 200, resp.content
    assert resp.data["status"] == "in_progress"

    resp = customer_client.get(f"/v1/contracts/{contract_id}")
    assert resp.data["execution_status"] == "in_progress"

    # --- сдача с файлом (ГВ.3: настоящий evidence-контур вместо заглушки) ---
    upload = SimpleUploadedFile("photo.jpg", b"stub-photo-bytes", content_type="image/jpeg")
    resp = contractor_client.post(
        f"/v1/milestones/{milestone_id}/evidence",
        {"checklist_item_id": checklist_item_id, "file": upload},
        format="multipart",
    )
    assert resp.status_code == 201, resp.content

    resp = contractor_client.post(
        f"/v1/milestones/{milestone_id}/submit", {"comment": "Готово"}, format="json"
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["status"] == "under_acceptance"

    # --- таймер приёмки виден в /acceptance (усиленная серия напоминаний) ---
    resp = customer_client.get(f"/v1/milestones/{milestone_id}/acceptance")
    assert resp.status_code == 200, resp.content
    assert resp.data["placed_in_cabinet"] is True
    assert resp.data["deadline_at"] is not None
    assert resp.data["hours_left"] is not None

    # --- вариант А: явная приёмка ---
    resp = customer_client.post(f"/v1/milestones/{milestone_id}/accept", format="json")
    assert resp.status_code == 200, resp.content
    assert resp.data["status"] == "accepted"

    # --- paid: подтверждение-заглушка обеими сторонами ---
    resp = customer_client.post(
        f"/v1/milestones/{milestone_id}/confirm-payment", {"side": "customer"}, format="json"
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["status"] == "accepted"

    resp = contractor_client.post(
        f"/v1/milestones/{milestone_id}/confirm-payment", {"side": "contractor"}, format="json"
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["status"] == "paid"

    resp = customer_client.get(f"/v1/contracts/{contract_id}")
    assert resp.data["execution_status"] == "warranty"  # completed -> warranty немедленно

    # --- вся история в timeline ---
    resp = customer_client.get(f"/v1/contracts/{contract_id}/timeline")
    assert resp.status_code == 200, resp.content
    topics = {event["topic"] for event in resp.data}
    expected_topics = {
        "contract.signed",
        "contract.started",
        "contract.completed",
        "contract.warranty_started",
    }
    assert expected_topics <= topics

    # --- Audit Vault: цепочка целостна ---
    relay.deliver_due_events()
    result = audit_vault_api.verify_chain()
    assert result.ok is True


def test_full_execution_path_services_business_auto_accept_reaches_completed():
    """Тот же сценарий, вариант Б: автоприёмка после серии напоминаний (тут
    — один сработавший дедлайн, ускоренный «конфиг» — сдвиг deadline_at в
    прошлое, эквивалент ускоренной длительности категории в бою). Отличия
    от free_c2c — только сегмент/налоговые пометки (contract_type_code=
    services_business, segment=paid_business, ADR-058); закрывающие
    заглушки вне объёма Э4.6 (генерация документов — не эта ветка)."""
    customer_client = APIClient()
    customer = _login(customer_client, "+79990890003")
    contractor_client = APIClient()
    contractor = _login(contractor_client, "+79990890004")
    accounts_services.set_business_status(contractor, True)
    contractor_profile = _person_profile(contractor)

    resp = customer_client.post(
        "/v1/contracts",
        {
            "client_option": "service",
            "my_role": "customer",
            "counterparty_profile_id": str(contractor_profile.id),
            "payment_method": "cash",
            "payment_order": "after_acceptance",
            "title": "Разработка сайта",
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    contract_id = resp.data["id"]
    assert resp.data["contract_type_code"] == "services_business"
    assert resp.data["segment"] == "paid_business"

    resp = customer_client.post(f"/v1/contracts/{contract_id}/send", format="json")
    assert resp.status_code == 200, resp.content

    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/milestones",
        {"title": "Вёрстка", "amount": "20000.00", "currency": "RUB"},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    milestone_id = resp.data["id"]

    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/freeze", format="json", HTTP_IDEMPOTENCY_KEY="freeze-2"
    )
    assert resp.status_code == 200, resp.content
    version_id = resp.data["id"]
    integrity_hash = resp.data["integrity_hash"]

    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/signature-requests",
        {"side": "customer", "version_id": version_id, "signatory_user_id": str(customer.id)},
        format="json",
        HTTP_IDEMPOTENCY_KEY="route-customer-2",
    )
    assert resp.status_code == 201, resp.content
    customer_request_id = resp.data["id"]

    resp = contractor_client.post(
        f"/v1/contracts/{contract_id}/signature-requests",
        {
            "side": "contractor",
            "version_id": version_id,
            "signatory_user_id": str(contractor.id),
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="route-contractor-2",
    )
    assert resp.status_code == 201, resp.content
    contractor_request_id = resp.data["id"]

    customer_client.post(
        f"/v1/signature-requests/{customer_request_id}/sign",
        {"version_hash": integrity_hash},
        format="json",
        HTTP_IDEMPOTENCY_KEY="sign-customer-2",
    )
    resp = contractor_client.post(
        f"/v1/signature-requests/{contractor_request_id}/sign",
        {"version_hash": integrity_hash},
        format="json",
        HTTP_IDEMPOTENCY_KEY="sign-contractor-2",
    )
    assert resp.status_code == 200, resp.content

    resp = customer_client.post(f"/v1/milestones/{milestone_id}/start", format="json")
    assert resp.status_code == 200, resp.content

    upload = SimpleUploadedFile("act.pdf", b"stub-act-bytes", content_type="application/pdf")
    resp = contractor_client.post(
        f"/v1/milestones/{milestone_id}/evidence", {"file": upload}, format="multipart"
    )
    assert resp.status_code == 201, resp.content

    resp = contractor_client.post(f"/v1/milestones/{milestone_id}/submit", format="json")
    assert resp.status_code == 200, resp.content
    assert resp.data["status"] == "under_acceptance"

    # --- вариант Б: автоприёмка после серии напоминаний (ускоренный "конфиг") ---
    deadline = DomainDeadline.objects.get(
        subject_type="milestone", subject_id=milestone_id, kind="milestone_acceptance"
    )
    deadline.deadline_at = timezone.now() - timedelta(hours=1)
    deadline.save(update_fields=["deadline_at"])
    fired = deadlines_tasks.sweep_domain_deadlines()
    assert fired == 1
    relay.deliver_due_events()

    resp = customer_client.get(f"/v1/milestones/{milestone_id}")
    assert resp.data["status"] == "accepted"

    resp = customer_client.post(
        f"/v1/milestones/{milestone_id}/confirm-payment", {"side": "customer"}, format="json"
    )
    assert resp.status_code == 200, resp.content
    resp = contractor_client.post(
        f"/v1/milestones/{milestone_id}/confirm-payment", {"side": "contractor"}, format="json"
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["status"] == "paid"

    resp = customer_client.get(f"/v1/contracts/{contract_id}")
    assert resp.data["execution_status"] == "warranty"

    # /timeline у договора несёт только subject.type=contract (apps.contracts.
    # selectors.get_timeline docstring) — milestone.auto_accepted виден в
    # СВОЁМ timeline этапа (та же лента, что видна в Audit Vault).
    resp = customer_client.get(f"/v1/milestones/{milestone_id}/timeline")
    assert resp.status_code == 200, resp.content
    milestone_topics = {event["topic"] for event in resp.data}
    assert "milestone.auto_accepted" in milestone_topics

    relay.deliver_due_events()
    result = audit_vault_api.verify_chain()
    assert result.ok is True


def test_confirm_payment_wrong_status_is_readable_409_not_500():
    """FSM-нарушение через HTTP — problem+json 409 `invalid_milestone_transition`:
    без маппинга в `_SERVICE_ERROR_STATUS` `InvalidTransitionError` уходил
    мимо `problem_json_exception_handler` пятисоткой (Ф4-gap, qa-backlog
    2026-08-20 — фронт гейтит кнопку по статусу, но контракт обязан быть
    читаемым и без фронта)."""
    customer_client = APIClient()
    _login(customer_client, "+79990890005")
    contractor = _login(APIClient(), "+79990890006")
    contractor_profile = _person_profile(contractor)

    resp = customer_client.post(
        "/v1/contracts",
        {
            "client_option": "service",
            "my_role": "customer",
            "counterparty_profile_id": str(contractor_profile.id),
            "payment_method": "cash",
            "payment_order": "after_acceptance",
            "title": "Поклейка обоев",
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    contract_id = resp.data["id"]

    resp = customer_client.post(f"/v1/contracts/{contract_id}/send", format="json")
    assert resp.status_code == 200, resp.content

    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/milestones",
        {"title": "Обои", "amount": "10000.00", "currency": "RUB"},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    milestone_id = resp.data["id"]

    # Этап ещё pending — `pay` допустим только из accepted (MILESTONE_FSM).
    resp = customer_client.post(
        f"/v1/milestones/{milestone_id}/confirm-payment", {"side": "customer"}, format="json"
    )
    assert resp.status_code == 409, resp.content
    assert resp.data["code"] == "invalid_milestone_transition"
