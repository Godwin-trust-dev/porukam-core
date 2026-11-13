"""apps.evidence.api — ГВ.3 приёмка (docs/tasks/global-wave.md) через
Swagger-эквивалент (APIClient): загрузка -> релей контрагенту (скачивание)
-> сверка хеша -> бэкап-заглушка; интеграция с Э4.6 (`submit` этапа
принимает evidence вместо файлов-заглушек)."""

from __future__ import annotations

import re

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIClient

from apps.accounts.api.views import _sms_gateway
from apps.accounts.models import User
from apps.profiles.models import Profile

from ._fixtures import jpeg_with_gps_exif_and_thumbnail, jpeg_without_exif

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


def _signed_contract_with_started_leaf(
    customer_phone: str, contractor_phone: str, suffix: str, *, with_required_evidence: bool = False
):
    customer_client = APIClient()
    customer = _login(customer_client, customer_phone)
    contractor_client = APIClient()
    contractor = _login(contractor_client, contractor_phone)
    # Регистрация по OTP (apps.accounts.services) ставит country_code="RU"
    # по построению (это и есть RU-канал входа) — большинству тестов этого
    # файла нужен GLOBAL-контур по умолчанию; кто хочет RU — выставляет
    # обратно явно (test_ru_mode_via_flag_keeps_original_in_s3).
    customer.country_code = None
    customer.save(update_fields=["country_code"])
    contractor.country_code = None
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
            "title": f"Сделка {suffix}",
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    contract_id = resp.data["id"]

    customer_client.post(f"/v1/contracts/{contract_id}/send", format="json")
    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/milestones",
        {"title": "Работа", "amount": "10000.00", "currency": "RUB"},
        format="json",
    )
    milestone_id = resp.data["id"]

    checklist_item_id = None
    if with_required_evidence:
        # Структура этапов (в т.ч. чек-лист) редактируется ТОЛЬКО до
        # заморозки (Э4.4 `_assert_editable`) — добавляем ДО freeze.
        resp = customer_client.post(
            f"/v1/milestones/{milestone_id}/checklist-items",
            {
                "description": "Готово по критерию",
                "measurable_criterion": "Визуальный осмотр",
                "required_evidence": ["photo"],
            },
            format="json",
        )
        assert resp.status_code == 201, resp.content
        checklist_item_id = resp.data["id"]

    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/freeze",
        format="json",
        HTTP_IDEMPOTENCY_KEY=f"freeze-{suffix}",
    )
    version_id, integrity_hash = resp.data["id"], resp.data["integrity_hash"]

    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/signature-requests",
        {"side": "customer", "version_id": version_id, "signatory_user_id": str(customer.id)},
        format="json",
        HTTP_IDEMPOTENCY_KEY=f"route-customer-{suffix}",
    )
    customer_request_id = resp.data["id"]
    resp = contractor_client.post(
        f"/v1/contracts/{contract_id}/signature-requests",
        {"side": "contractor", "version_id": version_id, "signatory_user_id": str(contractor.id)},
        format="json",
        HTTP_IDEMPOTENCY_KEY=f"route-contractor-{suffix}",
    )
    contractor_request_id = resp.data["id"]

    customer_client.post(
        f"/v1/signature-requests/{customer_request_id}/sign",
        {"version_hash": integrity_hash},
        format="json",
        HTTP_IDEMPOTENCY_KEY=f"sign-customer-{suffix}",
    )
    contractor_client.post(
        f"/v1/signature-requests/{contractor_request_id}/sign",
        {"version_hash": integrity_hash},
        format="json",
        HTTP_IDEMPOTENCY_KEY=f"sign-contractor-{suffix}",
    )
    resp = customer_client.post(f"/v1/milestones/{milestone_id}/start", format="json")
    assert resp.status_code == 200, resp.content

    return (
        customer_client,
        contractor_client,
        contract_id,
        milestone_id,
        customer,
        contractor,
        checklist_item_id,
    )


def _legacy_global_path() -> None:
    """ГВ.3-путь без серверного хранения — с 26.08 выключен данными
    (jurisdictions/0009, ADR-136); включаем явно, чтобы путь оставался
    покрытым."""
    from apps.jurisdictions.models import GLOBAL_COUNTRY_CODE, JurisdictionConfig

    JurisdictionConfig.objects.filter(country_code=GLOBAL_COUNTRY_CODE).update(
        evidence_server_storage_enabled=False
    )


def test_upload_download_verify_via_api():
    _legacy_global_path()
    customer_client, contractor_client, contract_id, milestone_id, customer, contractor, _item = (
        _signed_contract_with_started_leaf("+79990990001", "+79990990002", "1")
    )

    content = jpeg_with_gps_exif_and_thumbnail()
    upload = SimpleUploadedFile("photo.jpg", content, content_type="image/jpeg")
    resp = contractor_client.post(
        f"/v1/milestones/{milestone_id}/evidence", {"file": upload}, format="multipart"
    )
    assert resp.status_code == 201, resp.content
    evidence_id = resp.data["id"]
    assert resp.data["storage_mode"] == "global"
    assert resp.data["has_thumbnail"] is True
    assert resp.data["metadata"]["gps_stripped"] is True

    # миниатюра доступна отдельным эндпоинтом
    resp = customer_client.get(f"/v1/evidence/{evidence_id}/thumbnail")
    assert resp.status_code == 200, resp.content
    assert resp["Content-Type"] == "image/jpeg"

    # скачивание контрагентом = доставка, оригинал после этого удалён
    resp = customer_client.get(f"/v1/evidence/{evidence_id}/download")
    assert resp.status_code == 200, resp.content
    downloaded = b"".join(resp.streaming_content) if resp.streaming else resp.content

    resp = customer_client.get(f"/v1/evidence/{evidence_id}")
    assert resp.data["delivery_status"] == "delivered"

    # сверка предъявленного файла с хешом
    presented = SimpleUploadedFile("photo.jpg", downloaded, content_type="image/jpeg")
    resp = customer_client.post(
        f"/v1/evidence/{evidence_id}/verify", {"file": presented}, format="multipart"
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["matches"] is True

    tampered = SimpleUploadedFile(
        "photo.jpg", downloaded + b"\x00tamper", content_type="image/jpeg"
    )
    resp = customer_client.post(
        f"/v1/evidence/{evidence_id}/verify", {"file": tampered}, format="multipart"
    )
    assert resp.data["matches"] is False

    # второе скачивание — оригинала больше нет (GLOBAL)
    resp = customer_client.get(f"/v1/evidence/{evidence_id}/download")
    assert resp.status_code == 409, resp.content
    assert resp.data["code"] == "evidence_original_unavailable"


def test_backup_via_api_visible_status():
    customer_client, contractor_client, contract_id, milestone_id, customer, contractor, _item = (
        _signed_contract_with_started_leaf("+79990990003", "+79990990004", "2")
    )
    upload = SimpleUploadedFile("photo.jpg", jpeg_without_exif(), content_type="image/jpeg")
    resp = contractor_client.post(
        f"/v1/milestones/{milestone_id}/evidence", {"file": upload}, format="multipart"
    )
    evidence_id = resp.data["id"]

    # без привязанного Google-аккаунта — честный отказ, не 5xx
    resp = contractor_client.post(f"/v1/evidence/{evidence_id}/backup", format="json")
    assert resp.status_code == 200, resp.content
    assert resp.data["backup_status"] == "failed"
    assert resp.data["backup_failure_reason"]

    from apps.accounts.models import SocialLoginAccount

    SocialLoginAccount.objects.create(
        user=contractor, provider="google", sub="sub-api", email="a@x.com"
    )
    resp = contractor_client.post(f"/v1/evidence/{evidence_id}/backup", format="json")
    assert resp.status_code == 200, resp.content
    assert resp.data["backup_status"] == "completed"


def test_milestone_submit_reports_uncovered_evidence_without_blocking():
    """ADR-164 (решение владельца 05.09): непокрытый `required_evidence` СДАЧУ
    НЕ ОСТАНАВЛИВАЕТ — раньше здесь был 422 `required_evidence_not_covered`.
    Вместо отказа этап отдаёт `uncovered_required_evidence`: исполнителю это
    мягкое предупреждение в диалоге сдачи, заказчику — пометка при приёмке.
    Покрытие по-прежнему считается по реальным `apps.evidence` (файлы-заглушки
    apps.documents не участвуют) — после загрузки список пустеет."""
    (
        customer_client,
        contractor_client,
        contract_id,
        milestone_id,
        customer,
        contractor,
        checklist_item_id,
    ) = _signed_contract_with_started_leaf(
        "+79990990005", "+79990990006", "3", with_required_evidence=True
    )

    before = contractor_client.get(f"/v1/milestones/{milestone_id}")
    assert before.status_code == 200, before.content
    assert before.data["uncovered_required_evidence"] == [str(checklist_item_id)]

    resp = contractor_client.post(f"/v1/milestones/{milestone_id}/submit", format="json")
    assert resp.status_code == 200, resp.content
    assert resp.data["status"] == "under_acceptance"
    # Сдача прошла, но непокрытый пункт из ответа не пропал — заказчик увидит
    # пометку у него на приёмке.
    assert resp.data["uncovered_required_evidence"] == [str(checklist_item_id)]

    upload = SimpleUploadedFile("photo.jpg", jpeg_without_exif(), content_type="image/jpeg")
    resp = contractor_client.post(
        f"/v1/milestones/{milestone_id}/evidence",
        {"file": upload, "checklist_item_id": checklist_item_id},
        format="multipart",
    )
    assert resp.status_code == 201, resp.content

    after = customer_client.get(f"/v1/milestones/{milestone_id}")
    assert after.status_code == 200, after.content
    assert after.data["uncovered_required_evidence"] == []


def test_ru_mode_via_flag_keeps_original_in_s3():
    customer_client, contractor_client, contract_id, milestone_id, customer, contractor, _item = (
        _signed_contract_with_started_leaf("+79990990007", "+79990990008", "4")
    )
    contractor.country_code = "RU"
    contractor.save(update_fields=["country_code"])

    upload = SimpleUploadedFile("photo.jpg", jpeg_without_exif(), content_type="image/jpeg")
    resp = contractor_client.post(
        f"/v1/milestones/{milestone_id}/evidence", {"file": upload}, format="multipart"
    )
    assert resp.status_code == 201, resp.content
    assert resp.data["storage_mode"] == "server"
    evidence_id = resp.data["id"]

    # RU: скачивание не удаляет оригинал — второй раз тоже проходит
    resp = customer_client.get(f"/v1/evidence/{evidence_id}/download")
    assert resp.status_code == 200, resp.content
    resp = customer_client.get(f"/v1/evidence/{evidence_id}/download")
    assert resp.status_code == 200, resp.content


def test_upload_carries_author_description_to_every_file_of_the_batch():
    """Решение владельца 05.09: описание задаётся один раз на партию, но
    приезжает КАЖДЫМ файлом — строка Evidence дальше живёт сама по себе (лента
    спора, архивная выгрузка, релей контрагенту), и подпись «что тут снято»
    обязана ехать вместе с ней, а не с первым файлом партии.

    Заказчик — намеренно: бэк роль на загрузке не проверяет (`is_party`), и
    новое поле не должно этого менять."""
    customer_client, _contractor_client, _contract_id, milestone_id, _c, _p, item_id = (
        _signed_contract_with_started_leaf(
            "+79990990011", "+79990990012", "descr", with_required_evidence=True
        )
    )

    ids = []
    for name in ("скол-1.jpg", "скол-2.jpg"):
        upload = SimpleUploadedFile(name, jpeg_without_exif(), content_type="image/jpeg")
        resp = customer_client.post(
            f"/v1/milestones/{milestone_id}/evidence",
            {
                "file": upload,
                "checklist_item_id": item_id,
                "description": "  Скол на левом углу подоконника  ",
            },
            format="multipart",
        )
        assert resp.status_code == 201, resp.content
        # Пробелы по краям срезаны сериализатором — описание хранится ровно
        # тем текстом, который человек имел в виду.
        assert resp.data["description"] == "Скол на левом углу подоконника"
        ids.append(resp.data["id"])

    listing = customer_client.get(f"/v1/milestones/{milestone_id}/evidence")
    assert listing.status_code == 200, listing.content
    assert {row["description"] for row in listing.data} == {"Скол на левом углу подоконника"}

    detail = customer_client.get(f"/v1/evidence/{ids[0]}")
    assert detail.status_code == 200, detail.content
    assert detail.data["description"] == "Скол на левом углу подоконника"


def test_upload_without_description_stays_empty_not_null():
    """Описание необязательно: без него поле — пустая строка (не null), и
    клиенту не приходится различать «не сказал» и «сказал пусто»."""
    _customer_client, contractor_client, _contract_id, milestone_id, _c, _p, _item = (
        _signed_contract_with_started_leaf("+79990990013", "+79990990014", "nodescr")
    )

    upload = SimpleUploadedFile("photo.jpg", jpeg_without_exif(), content_type="image/jpeg")
    resp = contractor_client.post(
        f"/v1/milestones/{milestone_id}/evidence", {"file": upload}, format="multipart"
    )
    assert resp.status_code == 201, resp.content
    assert resp.data["description"] == ""


def test_description_over_limit_is_rejected_not_truncated():
    """2000 символов — предел поля. Обрезать молча нельзя: это подпись к
    юрзначимому артефакту, и потерянный хвост человек уже не восстановит
    (менять описание после создания нечем — PATCH на доказательство нет)."""
    _customer_client, contractor_client, _contract_id, milestone_id, _c, _p, _item = (
        _signed_contract_with_started_leaf("+79990990015", "+79990990016", "toolong")
    )

    upload = SimpleUploadedFile("photo.jpg", jpeg_without_exif(), content_type="image/jpeg")
    resp = contractor_client.post(
        f"/v1/milestones/{milestone_id}/evidence",
        {"file": upload, "description": "я" * 2001},
        format="multipart",
    )
    assert resp.status_code == 400, resp.content


def test_evidence_has_no_write_endpoint_for_description():
    """Инвариант «мягкого удаления/правки юрзначимых сущностей нет»
    (CLAUDE.md): описание — метаданные момента создания. Проверяем не
    докстрингом, а маршрутом: PATCH/PUT на доказательство не существует."""
    customer_client, contractor_client, _contract_id, milestone_id, _c, _p, _item = (
        _signed_contract_with_started_leaf("+79990990017", "+79990990018", "nopatch")
    )
    upload = SimpleUploadedFile("photo.jpg", jpeg_without_exif(), content_type="image/jpeg")
    resp = contractor_client.post(
        f"/v1/milestones/{milestone_id}/evidence",
        {"file": upload, "description": "первая редакция"},
        format="multipart",
    )
    evidence_id = resp.data["id"]

    patched = contractor_client.patch(
        f"/v1/evidence/{evidence_id}", {"description": "вторая редакция"}, format="json"
    )
    assert patched.status_code == 405, patched.content

    detail = customer_client.get(f"/v1/evidence/{evidence_id}")
    assert detail.data["description"] == "первая редакция"
