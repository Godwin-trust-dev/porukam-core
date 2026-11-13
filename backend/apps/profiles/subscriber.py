"""Подписчик apps.profiles на три топика outbox — единственный способ
узнать о событиях из apps.social/apps.accounts/apps.entities БЕЗ прямого
импорта (apps.social, в частности, по import-linter зависит ТОЛЬКО от
apps.accounts и не может звать apps.profiles напрямую; apps.profiles звать
apps.social/apps.accounts/apps.entities можно, но проще и симметричнее с
apps.notifications/apps.audit, ЭФ.1/ЭФ.4 — реагировать на событие, не
дёргать чужой сервис по фактам, которые и так публикуются).

- "account.logged_in" (created=True) — авто-создание person-профиля ПРИ
  РЕГИСТРАЦИИ (etap-3.md 3.5), видимость по умолчанию LINK_AND_DEALS
  (приватный вариант — сам профиль ещё не знает согласия profile_public,
  оно приходит следующим событием; дефолт НЕ public — тот же принцип
  минимизации, что и весь Р8/§1.3 дельты, просто применённый к видимости
  профиля, а не к discoverable_by_phone).
- "social.consent_recorded" (consent_type=profile_public) — обновляет
  видимость уже существующего (или лениво создаёт, если событие o
  регистрации почему-то не долетело первым — идемпотентно, update_or_create).
  docs/tasks/etap-3-delta-adr059.md §2 тест 6: «немедленно» — outbox+relay
  (sweep каждые 5с), в тестах — common.relay.deliver_due_events() синхронно.
- "entity.claimed" — создаёт бизнес-профиль claim'нутого юрлица (etap-3.md
  3.5: «бизнес-профиль — по claim'нутому юрлицу»)."""

from __future__ import annotations

from django.db import transaction

from apps.accounts.models import User
from common.models import OutboxEvent

from . import services, tasks
from .models import Profile

_PROFILE_PUBLIC = "profile_public"


def _handle_account_logged_in(event: OutboxEvent) -> None:
    if not (event.payload or {}).get("created"):
        return
    subject = event.subject or {}
    user_id = subject.get("id") if subject.get("type") == "user" else None
    if not user_id:
        return
    user = User.objects.filter(pk=user_id).first()
    if user is None:
        return
    profile = services.create_person_profile(user, profile_public=False)
    # ADR-103: стартовое фото из Google — только при регистрации (payload
    # несёт avatar_source_url лишь при created=True) и в фоне.
    avatar_source_url = (event.payload or {}).get("avatar_source_url")
    if avatar_source_url and not profile.avatar_key:
        transaction.on_commit(
            lambda: tasks.fetch_external_avatar.delay(str(profile.id), avatar_source_url)
        )


def _handle_consent_recorded(event: OutboxEvent) -> None:
    payload = event.payload or {}
    if payload.get("consent_type") != _PROFILE_PUBLIC:
        return
    subject = event.subject or {}
    user_id = subject.get("id") if subject.get("type") == "user" else None
    if not user_id:
        return
    user = User.objects.filter(pk=user_id).first()
    if user is None:
        return

    profile = Profile.objects.filter(kind=Profile.Kind.PERSON, owner_user=user).first()
    if profile is None:
        services.create_person_profile(user, profile_public=bool(payload["value"]))
        return
    services.update_visibility(
        profile,
        profile_visibility=(
            Profile.Visibility.PUBLIC if payload["value"] else Profile.Visibility.LINK_AND_DEALS
        ),
    )


def _handle_entity_claimed(event: OutboxEvent) -> None:
    subject = event.subject or {}
    entity_id = subject.get("id") if subject.get("type") == "business_entity" else None
    if not entity_id:
        return
    services.create_business_profile(entity_id)


_HANDLERS = {
    "account.logged_in": _handle_account_logged_in,
    "social.consent_recorded": _handle_consent_recorded,
    "entity.claimed": _handle_entity_claimed,
}


def handle_event(event: OutboxEvent) -> None:
    handler = _HANDLERS.get(event.topic)
    if handler is not None:
        handler(event)
