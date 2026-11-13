"""EN-версии title application/problem+json (ГВ.5, docs/tasks/global-wave.md,
ADR-075). `code` НИКОГДА не локализуется (common/api/problem.py) — здесь
только `title`, ключ реестра — тот же `code`, что уже поднимают
DomainAPIError-вызовы по всему проекту (apps/*/api/views.py,
apps/*/permissions.py).

Один код может обслуживать разные RU title в разных вызовах (например,
`not_found` — «Пользователь не найден» и «Тип договора не найден»);
здесь — ОДИН обобщённый EN title на код, не по вызову. Это осознанное
упрощение (тот же приём, что EN-болванки CONSENT_TEXT_VERSIONS/
NOTIFICATION_TOPIC_ADDRESSEE_TEMPLATES) — конкретика уходит в `detail` (см.
docstring problem_json_exception_handler), который здесь не переводится:
`detail` часто несёт динамический RU-текст из services.py (интерполяция
бизнес-данных), полный перевод — отдельная, более глубокая задача.

Код без записи в реестре — title остаётся RU (безопасный fallback, не
ошибка). Наполнение — постепенное, как i18n-справочники catalog/name_i18n."""

from __future__ import annotations

# Стандартные DRF-исключения (NotAuthenticated, PermissionDenied, NotFound,
# Throttled, ValidationError, …) переупаковываются с обобщённым code по
# HTTP-статусу (exceptions._STATUS_TO_CODE) и раньше уходили с
# `title == code` — фронт показывал «code: authentication_required»
# по-английски на любом языке (отсмотр 2026-08-24, ADR-119). Тексты — те же,
# что в l10n/packs/{ru,en}.json → errors: пакет в БД приоритетнее, это —
# фолбэк без пакета (свежая БД, тесты).
ERROR_TITLES_RU_STANDARD: dict[str, str] = {
    "invalid_request": "В запросе не хватает обязательных параметров.",
    "authentication_required": "Войдите, чтобы продолжить.",
    "permission_denied": "У вас нет прав на это действие.",
    "not_found": "Не найдено или недоступно.",
    "method_not_allowed": "Такой запрос здесь не поддерживается.",
    "not_acceptable": "Запрошенный формат ответа не поддерживается.",
    "conflict": "Действие конфликтует с текущим состоянием. Обновите страницу и попробуйте снова.",
    "unsupported_media_type": "Неподдерживаемый формат данных.",
    "unprocessable_entity": "Данные не прошли проверку.",
    "rate_limited": "Слишком много запросов. Подождите немного и попробуйте снова.",
    "error": "Что-то пошло не так. Попробуйте ещё раз.",
}

ERROR_TITLES_EN_STANDARD: dict[str, str] = {
    "invalid_request": "The request is missing required parameters.",
    "authentication_required": "Please sign in to continue.",
    "permission_denied": "You don't have permission to perform this action.",
    "not_found": "Not found or unavailable.",
    "method_not_allowed": "This request is not supported here.",
    "not_acceptable": "The requested response format is not supported.",
    "conflict": "This action conflicts with the current state. Refresh and try again.",
    "unsupported_media_type": "Unsupported data format.",
    "unprocessable_entity": "The data did not pass validation.",
    "rate_limited": "Too many requests. Please wait a moment and try again.",
    "error": "Something went wrong. Please try again.",
}

ERROR_TITLES_EN: dict[str, str] = {
    # apps.accounts
    "otp_rate_limited": "Too many requests",
    "otp_code_expired": "Code expired",
    "otp_invalid_code": "Incorrect code",
    "phone_login_disabled": "Phone sign-in is disabled",
    "email_login_disabled": "Email sign-in is disabled",
    "google_oauth_state_invalid": "Google sign-in session expired or invalid",
    "google_oauth_code_invalid": "Google authorization code not recognized",
    "refresh_token_invalid": "Refresh token is invalid",
    "invalid_public_key": "public_key must be valid base64",
    "device_not_found": "Device not found",
    "account_deletion_blocked": "Finish your active deals first",
    # apps.identity
    "esia_state_invalid": "ESIA verification session expired or invalid",
    "esia_code_invalid": "ESIA verification code not recognized",
    "verification_required": "A higher verification level is required",
    # apps.social
    "invalid_handle_format": "Invalid handle format",
    "handle_taken": "This handle is already taken",
    "invalid_phonebook_hash": "Expected hashes, not raw phone numbers",
    "handle_required": "An active @handle is required",
    "pd_processing_consent_required": "Registration requires consent to personal data processing",
    "permission_denied": "Permission denied",
    "not_found": "Not found",
    # apps.entities
    "entity_not_found_in_registry": "Company not found in the registry",
    "entity_liquidated": "Company is liquidated according to the registry",
    "entity_not_operable": "Control over the company has not been confirmed",
    "claim_method_not_available": "This verification method is not available yet",
    "claim_method_not_satisfied": "Conditions for the selected method are not met",
    # apps.contracts
    "form_data_invalid": "form_data does not match the schema",
    "idempotency_key_required": "Idempotency-Key header is required",
    "confirm_summary_required": "Financially significant changes require confirmation",
    # ADR-123: адресуемые правки протокола разногласий.
    "revision_item_unknown": "There is no such field in this deal type's form",
    "revision_value_invalid": "The proposed value does not pass validation",
    "contract_type_excluded": "This deal type is not supported on the platform",
    "not_yet_supported": "This deal type is coming soon",
    "invalid_request": "Parameter 'side' is required: customer or contractor",
    # apps.milestones
    "contract_immutable": "Milestone structure can only be edited before signing",
    "milestone_wrong_contract": "Parent milestone belongs to a different agreement",
    "milestone_depth_exceeded": "Maximum milestone tree depth exceeded",
    "milestone_amount_guard": "Amount is only allowed on a leaf of the milestone tree",
    "milestone_has_leaf_content": "This milestone already has a checklist or materials"
    " — it's a leaf, not a branch",
    "milestone_not_leaf": "Checklist and materials are only allowed on a leaf",
    "currency_not_active": "Currency is not active in the catalog",
    "material_price_required": "The contractor cannot supply material at zero price",
    "amount_currency_required": "amount and currency must be provided together",
    "loan_schedule_not_applicable": "Repayment schedule is not applicable here",
    # apps.notifications
    "in_app_channel_cannot_be_disabled": "In-app notifications cannot be disabled",
    # apps.payments (ADR-130). В языковые пакеты эти коды НЕ доливались:
    # `errors` в пакете проверяется на полноту относительно EN-канона
    # (apps/l10n/tests/test_packs_coverage.py), то есть первый же ключ в
    # en.json потребовал бы 29 переводов сразу. Встроенный EN-реестр —
    # штатное второе звено цепочки фолбэков (см. докстринг модуля), и для
    # контура, у которого фронтовые тексты ещё будут пересматриваться под
    # платёжного партнёра, это честнее, чем 29 машинных переводов, которые
    # придётся переписывать.
    "payment_provider_not_configured": "Payment through the platform will arrive"
    " with the payment module",
    "payment_not_payable": "Only a money leaf of the milestone tree can be paid",
    "milestone_not_payable": "Only a money leaf of the milestone tree can be paid",
    "contract_not_signed": "An invoice is only issued for a signed agreement",
    "invalid_payment_transition": "This action is not allowed for the current payment status",
    "payment_advance_not_cancellable": "An advance cannot be cancelled"
    " — it is the condition for starting the milestone",
    "wrong_confirmation_side": "You cannot confirm on behalf of the other party",
    "advance_confirmation_not_applicable": "Advance confirmation is only available for prepayment",
    "invalid_milestone_transition": "This action is not allowed for the current milestone status",
    "webhook_malformed": "The webhook could not be parsed",
    "idempotency_key_reused": "This Idempotency-Key was already used with a different body",
}
