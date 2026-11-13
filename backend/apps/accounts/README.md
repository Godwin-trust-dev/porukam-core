# apps.accounts

`User` (uuid7 PK, `trust_id` непубличный, `has_business_status` — меняется
только сервисом claim из `apps.entities`, этап 3.4), `UserDevice`,
`DeviceKey`, `SocialLoginAccount` (ГВ.2). Вход — два способа:

- телефон+SMS-код (фейковый провайдер, `providers.SMSGateway`/`FakeSMSGateway`) —
  RU-волна, в GLOBAL не предлагается; выключается настройкой `PHONE_LOGIN_ENABLED`
  (ADR-165): при `false` оба эндпоинта `auth/otp/*` отвечают `403
  phone_login_disabled`, в проде на публикацию так и стоит. Привязка телефона к уже
  вошедшему аккаунту (`PATCH /users/me`) флагом не закрыта — войти по ней нельзя;
- Google OAuth (`providers.GoogleOAuthProvider`/`FakeGoogleOAuthProvider`,
  state+PKCE на сервере, тот же приём, что фейк-ЕСИА ADR-062) —
  `services.build_google_authorize_url`/`complete_google_login`, второй
  способ входа, доступен в обоих контурах. `SocialLoginAccount.provider`+`sub` —
  стабильный ключ связки; `email` там же — обновляемый атрибут, `User.email`
  подставляется из него только при регистрации (см. docstring модели).

Оба способа выдают одну и ту же пару JWT (access 15 мин / refresh 30 дней,
ротация+блэклист, `djangorestframework-simplejwt`) через общий
`_issue_token_pair`; первый вход = регистрация в обоих случаях, и оба
проставляют стартовый `country_code` (RU/GLOBAL — ГВ.5, см. ниже). Мидлварь
`X-Acting-Profile` — `middleware.py`: разбор/валидация формата + ПОЛНОЦЕННАЯ
проверка принадлежности (профиль мой либо юрлица, где я активный
Representative, etap-3.md 3.5) через `apps.profiles.selectors.can_act_as` —
резолвит JWT напрямую (`JWTAuthentication().authenticate(request)`), не
дожидаясь `request.user` (тот на этапе raw-мидлвари ещё не аутентифицирован
DRF).

`User.country_code` (ГВ.1/ГВ.5, docs/tasks/global-wave.md, ADR-070/075) —
явный выбор страны, self-service через `PATCH /users/me`
(`services.update_profile`, как email/full_name — не «единственный
санкционированный мутатор», этим полем не владеет чужое приложение).
`verify_otp`/`complete_google_login` проставляют стартовое значение
(`"RU"`/`"GLOBAL"`) на регистрации — без этого «нет страны → GLOBAL»
(резолвер ГВ.1) сломало бы язык ошибок для существующих RU-пользователей.
`selectors.get_user_locale(user)` — язык контура пользователя
(`apps.jurisdictions.selectors.resolve_locale`).

Слои: `services.py` (OTP/Google-вход/токены/профиль/устройства — единственная
точка мутации `has_business_status`, `set_phone_discoverability`),
`selectors.py` (расшифровка `full_name`, язык контура), `api/` (DRF:
`serializers.py`, `views.py`, `urls.py`), `models.py`.

Реализовано по docs/tasks/etap-3.md §3.1 + 3.5 + docs/tasks/global-wave.md
ГВ.2/ГВ.5. `GET /users/me` включает `profiles` (facade через
`django.utils.module_loading.import_string`,
`settings.USER_ME_PROFILES_SELECTOR`/`_SERIALIZER` — НЕ прямой импорт
`apps.profiles` в `api/serializers.py`: import-linter держит контракт
«apps.social зависит только от apps.accounts», прямой импорт протёк бы
транзитивно, см. `docs/adr/ADR-074-authority-profiles.md`). Верификация
(`apps.identity`) — отдельная под-задача.

Решения: docs/adr/ADR-059 (envelope-шифрование `full_name_encrypted`),
ADR-060 (outbox), ADR-061 (JWT + OTP), ADR-071 (Google OAuth, ГВ.2),
ADR-074 (X-Acting-Profile, изоляция от apps.profiles), ADR-075 (i18n/локаль,
ГВ.5), ADR-165 (`PHONE_LOGIN_ENABLED` — вход только по аккаунту Google).
