"""Подписчик apps.social на события договора — контакты source=deal (ADR-106).

Отсмотр 2026-08-21: «при начале работы с договором контрагент должен попадать
в сохранённые контакты». apps.social по import-linter зависит ТОЛЬКО от
apps.accounts, поэтому о договорах узнаёт из outbox (тот же приём, что
apps.profiles.subscriber), а стороны берёт из payload["party_user_ids"] —
apps.contracts кладёт их в contract.drafted / draft_patched / signed.

Направления:
- drafted / draft_patched — ИНИЦИАТОР правки (actor) получает контрагента:
  это он «начал работу», контрагент ещё ничего не делал и свои контакты не
  засорял.
- signed — обе стороны получают друг друга: подпись — обоюдное действие.

Идемпотентно: Contact уникален по (owner, target_user) — повтор события и
любой уже существующий контакт (manual/phonebook/link) не трогаются, источник
не «понижается» до deal."""

from __future__ import annotations

import logging

from django.db import IntegrityError, transaction

from apps.accounts.models import User
from common.models import OutboxEvent

from .models import Contact

logger = logging.getLogger(__name__)

_ACTOR_TOPICS = frozenset({"contract.drafted", "contract.draft_patched"})
_MUTUAL_TOPICS = frozenset({"contract.signed"})


def _ensure_deal_contact(owner: User, target: User) -> None:
    if owner.pk == target.pk:
        return
    if Contact.objects.filter(owner=owner, target_user=target).exists():
        return
    try:
        with transaction.atomic():
            Contact.objects.create(owner=owner, target_user=target, source=Contact.Source.DEAL)
    except IntegrityError:
        # Гонка двух событий одного договора — контакт уже есть, это и нужно.
        return


def handle_event(event: OutboxEvent) -> None:
    topic = event.topic
    if topic not in _ACTOR_TOPICS and topic not in _MUTUAL_TOPICS:
        return
    party_ids = [str(i) for i in (event.payload or {}).get("party_user_ids") or []]
    if len(party_ids) < 2:
        return
    users = {str(u.pk): u for u in User.objects.filter(pk__in=party_ids)}
    if len(users) < 2:
        return

    if topic in _MUTUAL_TOPICS:
        for owner_id in party_ids:
            for target_id in party_ids:
                if owner_id != target_id and owner_id in users and target_id in users:
                    _ensure_deal_contact(users[owner_id], users[target_id])
        return

    actor_id = str((event.actor or {}).get("user_id") or "")
    owner = users.get(actor_id)
    if owner is None:
        logger.info("social.subscriber: %s без actor среди сторон — пропуск", topic)
        return
    for target_id in party_ids:
        if target_id != actor_id and target_id in users:
            _ensure_deal_contact(owner, users[target_id])
