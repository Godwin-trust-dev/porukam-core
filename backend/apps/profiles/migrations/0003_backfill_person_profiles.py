"""etap-3.md 3.5: «авто-создание person-профиля при регистрации пользователя
(миграция данных для существующих)». Видимость — из последнего согласия
profile_public (apps.social.Consent), если пользователь его уже дал; иначе
консервативный дефолт link_and_deals (тот же принцип минимизации, что и
subscriber.py для новых регистраций — НЕ public по умолчанию)."""

from __future__ import annotations

from django.db import migrations


def backfill(apps, schema_editor):
    User = apps.get_model("accounts", "User")
    Profile = apps.get_model("profiles", "Profile")
    Consent = apps.get_model("social", "Consent")

    existing_owner_ids = set(
        Profile.objects.filter(kind="person").values_list("owner_user_id", flat=True)
    )
    to_create = []
    for user in User.objects.exclude(pk__in=existing_owner_ids).iterator():
        latest_consent = (
            Consent.objects.filter(user_id=user.pk, consent_type="profile_public")
            .order_by("-granted_at")
            .first()
        )
        visibility = "public" if latest_consent and latest_consent.value else "link_and_deals"
        to_create.append(Profile(kind="person", owner_user_id=user.pk, profile_visibility=visibility))
    Profile.objects.bulk_create(to_create, ignore_conflicts=True)


def noop_reverse(apps, schema_editor):
    """Обратная миграция намеренно НЕ удаляет — нельзя отличить «создан этой
    миграцией» от «создан позже обычным потоком» (auto-create при
    регистрации использует ту же update_or_create-семантику)."""


class Migration(migrations.Migration):

    dependencies = [
        ("profiles", "0002_portfolio_portfolioproject"),
        ("accounts", "0003_discoverable_by_phone_and_handle"),
        ("social", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(backfill, noop_reverse),
    ]
