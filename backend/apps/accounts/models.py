"""tech-spec.md §5.2.1, §7.2, §7.3; domain-model.md §3.1.

User.trust_id — сквозной идентификатор субъекта (задел под внешний
распределённый реестр), НЕПУБЛИЧНЫЙ: ни один сериализатор apps.accounts.api
не должен его отдавать (проверяется тестом test_api.py).

User.has_business_status — хранимый флаг, "ТОЛЬКО собственный СМЗ/ИП"
(CLAUDE.md). Здесь — только поле и default=False; единственный сценарий его
изменения — apps.accounts.services.set_business_status(), вызываемый из
сервиса claim в apps.entities (этап 3.4). PATCH /users/me его не трогает.

ПД (full_name) — envelope-шифрование (common/crypto.py) с первой миграции
(CLAUDE.md, ADR-035 внешнего журнала / docs/adr/ADR-059-*.md для локальной
реализации): full_name_encrypted + encryption_key_ref, plaintext нигде не
хранится.
"""

from __future__ import annotations

from typing import Any, ClassVar

from django.contrib.auth.base_user import AbstractBaseUser, BaseUserManager
from django.db import models

from common.uuid7 import uuid7

_CI_COLLATION = "case_insensitive"


class UserManager(BaseUserManager["User"]):
    """Пользователи создаются только через apps.accounts.services (OTP-вход),
    не через Django admin/createsuperuser — вход паролем не предусмотрен."""

    use_in_migrations = True

    def create_user(self, phone: str, **extra: Any) -> User:
        if not phone:
            raise ValueError("phone обязателен")
        user = self.model(phone=phone, **extra)
        user.set_unusable_password()
        user.save(using=self._db)
        return user

    def create_superuser(self, phone: str, **extra: Any) -> User:
        raise NotImplementedError(
            "суперпользователей в этом периметре нет — "
            "служебный SSO+2FA отдельно (tech-spec.md §7.2)"
        )


class User(AbstractBaseUser):
    class VerificationLevel(models.TextChoices):
        GUEST = "guest", "Гость"
        BASIC = "basic", "Базовый"
        VERIFIED = "verified", "Верифицирован"
        BUSINESS = "business", "Бизнес"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    trust_id = models.CharField(max_length=64, unique=True, editable=False)

    phone = models.CharField(
        max_length=32, unique=True, null=True, blank=True, db_collation=_CI_COLLATION
    )
    email = models.CharField(
        max_length=254, unique=True, null=True, blank=True, db_collation=_CI_COLLATION
    )
    # Момент, когда владение ЭТИМ ящиком доказано вводом кода из письма
    # (ADR-168). NULL — адрес вписан самим пользователем (PATCH /users/me,
    # services.update_profile) и никем не подтверждён: по нему нельзя войти
    # и к нему нельзя привязать вход, иначе достаточно было бы вписать чужой
    # адрес в свой профиль, чтобы получить чужие сделки. Это граница
    # «заявленное» / «доказанное», и она юридически значима.
    #
    # Инвариант: поле относится к ТЕКУЩЕМУ значению email — вместе они
    # меняются только в services.verify_email_otp (ставит подтверждение) и
    # при отвязке неподтверждённого адреса (email=None; поле и так NULL).
    # update_profile подтверждения не выдаёт никогда.
    email_verified_at = models.DateTimeField(null=True, blank=True)

    full_name_encrypted = models.BinaryField(null=True, blank=True)
    encryption_key_ref = models.CharField(max_length=64, null=True, blank=True)

    verification_level = models.CharField(
        max_length=16, choices=VerificationLevel.choices, default=VerificationLevel.GUEST
    )
    personal_tax_id_hash = models.CharField(max_length=128, null=True, blank=True)
    has_business_status = models.BooleanField(default=False)

    # Страна — ТОЛЬКО явный выбор пользователя (ГВ.1/ГВ.5, docs/tasks/
    # global-wave.md, ADR-070/074): fallback-резолвер apps.jurisdictions.
    # selectors.resolve_jurisdiction/resolve_locale читает это поле, не
    # гео/IP. NULL — пользователь ещё не выбрал страну (резолвится в контур
    # GLOBAL). С ADR-148 Google-вход больше не пишет сюда литерал GLOBAL —
    # обещание «только явный выбор» наконец выполняется; телефонная ветка
    # по-прежнему ставит RU (ГВ.2/ADR-075: контур определяет право, а не
    # статистику, см. services.verify_otp). Self-service поле — меняется
    # через apps.accounts.services.
    # update_profile() (PATCH /users/me), как email/full_name; не «единственный
    # санкционированный мутатор» — тем полям, которые мутирует ДРУГОЕ
    # приложение (has_business_status, discoverable_by_phone,
    # verification_level), а не сам пользователь.
    #
    # ТОЛЬКО ЮРИСДИКЦИЯ (план 11.09 §4, ADR-182): это поле отвечает ровно на
    # один вопрос — какое право применимо к пользователю, и ни на какой
    # другой. Это НЕ адрес проживания и НЕ география, где человек ищет
    # заказы/работает — та живёт отдельно, в `apps.profiles.WorkArea`
    # (справочник `apps.geo`), выбирается независимо и НИКОГДА не
    # перезаписывает это поле. До ADR-182 два факта были смешаны (страна
    # аккаунта одновременно читалась и как юрисдикция, и как география
    # поиска в `apps.dashboards`), из-за чего «страна Россия, город Дели» в
    # профиле выглядело противоречием — на самом деле это было два разных
    # вопроса без места для второго ответа.
    country_code = models.CharField(max_length=8, null=True, blank=True)

    # Язык интерфейса — ЯВНЫЙ выбор в переключателе, отдельно от страны
    # (ADR-095): контур (country_code -> JurisdictionConfig.primary_locale)
    # знает ровно два языка, ru и en, потому что плагинов контуров всего два —
    # он не может выразить «я в Германии и читаю по-немецки». До этого поля
    # выбор языка жил только в localStorage SPA, а PATCH /users/me {locale}
    # молча терялся (UserMeUpdateSerializer поля не принимал) — человек видел
    # немецкий интерфейс и английские письма.
    #
    # NULL — языка нет; резолвер (common/i18n.resolve_request_locale)
    # падает на прежнюю цепочку контур -> Accept-Language. С ADR-148 пустым
    # поле остаётся редко: вход (и первый, и любой следующий, пока тут пусто)
    # записывает сюда язык запроса — «на каком языке человек пользуется
    # приложением», а не только «что он выбрал в переключателе». Явный выбор
    # НИКОГДА не перетирается; поле заполняется только вместо пустоты, иначе
    # заголовок браузера с чужого устройства отменял бы выбор. Код НЕ валидируется
    # против apps.l10n.Locale при записи — ровно по той же причине, что и
    # country_code выше: это фиксация выбора, а решение «есть ли под него
    # пакет» принимается при ЧТЕНИИ (выключение языка рубильником ops не
    # должно ретроактивно ломать сохранённый профиль).
    locale = models.CharField(max_length=16, null=True, blank=True)

    # Находимость (etap-3.md 3.3; docs/tasks/etap-3-delta-adr059.md §1.3):
    # discoverable_by_phone — NULL до явного выбора на шаге «Данные и
    # приватность» (apps.social.services.record_consent), НИКАКОГО дефолта
    # True — регистрация не завершается с NULL (apps.social.selectors.
    # is_privacy_step_complete). Единственный санкционированный способ
    # изменить — apps.accounts.services.set_phone_discoverability(), вызываемый
    # из apps.social при записи согласия phone_discoverability.
    discoverable_by_phone = models.BooleanField(null=True, blank=True)
    # discoverable_by_handle — НЕ согласие 152-ФЗ (хендл публичен по своей
    # природе — 3 согласия дельты его не включают), дефолт True допустим.
    discoverable_by_handle = models.BooleanField(default=True)

    is_active = models.BooleanField(default=True)
    is_banned = models.BooleanField(default=False)

    # Момент удаления аккаунта самим пользователем (DELETE /users/me,
    # ADR-169). Это НЕ мягкое удаление юрзначимой сущности (CLAUDE.md его
    # запрещает): строка `user` остаётся не «на всякий случай», а потому что
    # на ней держатся подписи, стороны договоров и доказательства — все FK
    # на пользователя в проекте PROTECT, и физически удалить его нельзя, не
    # разрушив доказательную базу чужих сделок. ПД при этом не «прячутся», а
    # уничтожаются необратимо (crypto-shredding ключа субъекта + обнуление
    # незашифрованных контактов), поэтому оставшаяся строка ПД не содержит.
    #
    # NULL — живой аккаунт. Непустое значение всегда идёт в паре с
    # `is_active=False`: вход отсекает сам SimpleJWT (JWTAuthentication
    # проверяет `is_active` и отдаёт 401 `user_inactive`), поле нужно как
    # ДАТА (когда именно ПД уничтожены — ответ надзорному органу и та самая
    # `deleted_at` в теле 202), а не как второй флаг доступа.
    deleted_at = models.DateTimeField(null=True, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)

    objects = UserManager()

    USERNAME_FIELD = "phone"
    REQUIRED_FIELDS: ClassVar[list[str]] = []

    class Meta:
        db_table = "user"
        verbose_name = "пользователь"
        verbose_name_plural = "пользователи"

    def __str__(self) -> str:
        return self.trust_id


class SocialLoginAccount(models.Model):
    """Связка внешнего OAuth-аккаунта ↔ User (ГВ.2, docs/tasks/global-wave.md,
    ADR-071) — второй способ входа рядом с OTP (`providers.GoogleOAuthProvider`,
    `services.complete_google_login`).

    `provider` + `sub` — стабильный ключ связки (у провайдера `sub` не
    меняется никогда, это и есть его контракт с OAuth-клиентами); первый
    вход тем же `sub` = регистрация, повторный — тот же User.

    `email` здесь — «обновляемый атрибут» связки (перечитывается на каждый
    вход), а НЕ то же самое, что `User.email`: `User.email` — self-service
    поле (PATCH /users/me, apps.accounts.services.update_profile), вход
    через Google на другой почте не должен молча его перезаписывать —
    `User.email` подставляется отсюда только один раз, при регистрации."""

    user = models.ForeignKey(User, related_name="social_login_accounts", on_delete=models.CASCADE)
    provider = models.CharField(max_length=32)
    sub = models.CharField(max_length=255)
    email = models.CharField(max_length=254, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    last_login_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "social_login_account"
        verbose_name = "внешний аккаунт входа"
        verbose_name_plural = "внешние аккаунты входа"
        constraints = [
            models.UniqueConstraint(
                fields=["provider", "sub"], name="social_login_account_provider_sub_unique"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.provider}:{self.sub}"


class GoogleDriveGrant(models.Model):
    """Инкрементальная авторизация Drive (ADR-084, docs/tasks/Задача_feat_
    evidence-drive.md §2.1) — ОТДЕЛЬНО от входа (`SocialLoginAccount`/ADR-071):
    вход даёт только openid/email/profile, Drive-токены не запрашивает и не
    хранит. Грант привязан к конкретному `SocialLoginAccount` (тому же Google-
    аккаунту, что вход), а не напрямую к `User`, — так `account_sub` (единственный
    идентификатор, который получает `GoogleDriveBackupProvider.upload()`,
    контракт Protocol не меняется) резолвится в грант без обхода через `User`.

    `refresh_token_encrypted` — envelope-шифрование (`common/crypto.py`,
    ADR-059), subject_type="google_drive_grant"/subject_id=`social_account.id`.
    Access-токен НЕ хранится (короткоживущий, получается по refresh на каждый
    вызов — `apps.accounts.services.get_drive_access_token`).

    `granted_scope` — зафиксирован ADR-084: единственное значение в проде —
    `https://www.googleapis.com/auth/drive.file`, шире не бывает."""

    class Status(models.TextChoices):
        ACTIVE = "active", "Активен"
        REVOKED = "revoked", "Отозван"

    social_account = models.OneToOneField(
        SocialLoginAccount, related_name="drive_grant", on_delete=models.CASCADE
    )
    refresh_token_encrypted = models.BinaryField()
    encryption_key_ref = models.CharField(max_length=64)
    granted_scope = models.CharField(max_length=255)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.ACTIVE)
    granted_at = models.DateTimeField(auto_now_add=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "google_drive_grant"
        verbose_name = "грант Google Drive"
        verbose_name_plural = "гранты Google Drive"

    def __str__(self) -> str:
        return f"{self.social_account_id}:{self.status}"


class UserDevice(models.Model):
    class Platform(models.TextChoices):
        IOS = "ios", "iOS"
        ANDROID = "android", "Android"
        WEB = "web", "Web"

    user = models.ForeignKey(User, related_name="devices", on_delete=models.CASCADE)
    platform = models.CharField(max_length=16, choices=Platform.choices)
    push_token = models.CharField(max_length=255, blank=True, default="")
    last_seen_at = models.DateTimeField(auto_now=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "user_device"
        verbose_name = "устройство пользователя"
        verbose_name_plural = "устройства пользователей"

    def __str__(self) -> str:
        return f"{self.user_id}:{self.platform}"


class DeviceKey(models.Model):
    """Только регистрация ключа; криптопроверки подписей — в apps.evidence
    (etap-3.md 3.1)."""

    device = models.ForeignKey(UserDevice, related_name="keys", on_delete=models.CASCADE)
    user = models.ForeignKey(User, related_name="device_keys", on_delete=models.CASCADE)
    public_key = models.BinaryField()
    algorithm = models.CharField(max_length=32)
    issued_at = models.DateTimeField(auto_now_add=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "device_key"
        verbose_name = "ключ устройства"
        verbose_name_plural = "ключи устройств"

    def __str__(self) -> str:
        return f"{self.device_id}:{self.algorithm}"
