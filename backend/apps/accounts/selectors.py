"""Read-слой apps.accounts."""

from __future__ import annotations

from apps.jurisdictions.selectors import resolve_locale
from common.crypto import SubjectKeyDestroyedError, decrypt_for_subject
from common.i18n import resolve_user_locale

from .models import User


def get_full_name(user: User) -> str | None:
    """Расшифровывает full_name_encrypted. None, если ФИО не заполнено ЛИБО
    ключ субъекта уничтожен (crypto-shredding) — для читателя это одно и то
    же "имени нет", различать не нужно."""
    if not user.full_name_encrypted or not user.encryption_key_ref:
        return None
    try:
        return decrypt_for_subject(bytes(user.full_name_encrypted), user.encryption_key_ref)
    except SubjectKeyDestroyedError:
        return None


def has_active_push_device(user: User) -> bool:
    """apps.notifications.providers.FakePushProvider (docs/tasks/fundament.md
    ЭФ.4) читает наличие токена ЧЕРЕЗ этот селектор, не импортируя
    UserDevice напрямую (CLAUDE.md: приложения общаются через
    services.py/selectors.py-фасады, не через прямой импорт чужих моделей)."""
    return user.devices.exclude(push_token="").exists()


def get_user_locale(user: User) -> str:
    """Язык КОНКРЕТНОГО пользователя (ГВ.5, ADR-075; переработано ADR-095) —
    канонический способ; другие приложения читают отсюда, а не строят свой
    резолвер поверх country_code.

    С ADR-095 это выбранный язык интерфейса (`User.locale`) с фолбэком на
    язык контура: контур различает только ru и en, поэтому сам по себе он не
    мог быть ответом на вопрос «на каком языке писать этому человеку»."""
    return resolve_user_locale(user) or resolve_locale(user.country_code)
