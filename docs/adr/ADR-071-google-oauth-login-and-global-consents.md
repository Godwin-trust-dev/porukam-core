# ADR-071. Вход через Google OAuth + стартовый пакет согласий GLOBAL

**Статус:** принято
**Дата:** 2026-08-06
**Контекст этапа:** ГВ.2 (`feat/auth-google`, docs/tasks/global-wave.md)

## Контекст

Постановка ГВ.2 просит «EN-версии трёх согласий ADR-059» — в этом
репозитории номер ADR-059 занят envelope-шифрованием
(`ADR-059-envelope-encryption-common.md`). Это не новая проблема:
`ADR-067-social-consent-profile-visibility.md` уже фиксировал ровно такую же
коллизию для тех же трёх согласий («дельта ссылается на "ADR-059 финал"
внешнего журнала — это ДРУГОЙ документ»). Здесь та же ситуация:
«ADR-059» постановки ГВ.2 — это `apps.social.Consent` (ADR-067,
`ConsentType.PD_PROCESSING/PROFILE_PUBLIC/PHONE_DISCOVERABILITY`), не
локальный envelope-ADR. Аналогично «ADR-062» ниже — это ссылка на
существующий `ADR-062-esia-fake-progressive-kyc.md` (паттерн state+PKCE),
номер здесь совпадает с реальным и путаницы не создаёт.

## Решение

### Google OAuth — второй способ входа (`apps.accounts`)

- **`GoogleOAuthProvider` (Protocol) + `FakeGoogleOAuthProvider`**
  (`apps/accounts/providers.py`) — тот же приём, что `FakeEsiaProvider`
  (ADR-062): код авторизации сам кодирует результат (`"sub|email"`), тесты
  управляют входом напрямую.
- **state+PKCE на сервере, но БЕЗ user_id в state.** ESIA привязывает state
  к уже аутентифицированному пользователю (`{"user_id": ..., "code_verifier": ...}`)
  — там верификация поднимает уровень уже существующего профиля. Google —
  вход, на шаге `authorize-url` пользователя ещё нет (первый вход =
  регистрация), поэтому `GoogleAuthorizeUrlView`/`GoogleCallbackView` —
  `AllowAny`, а `services.build_google_authorize_url`/`complete_google_login`
  в кеше хранят только `code_verifier`. `GoogleOAuthStateInvalidError` не
  различает «не найден» и «истёк» — та же CSRF-дисциплина, что
  `EsiaStateInvalidError`.
- **`SocialLoginAccount(user, provider, sub, email)`**, `UniqueConstraint(provider, sub)` —
  связка Google-аккаунта с User. `sub` — стабильный ключ (повторный вход тем
  же `sub` — тот же `user_id`, проверено тестом), `email` на этой модели —
  обновляемый атрибут (перечитывается на каждый вход). `User.email`
  подставляется из него ТОЛЬКО при регистрации (первой связке для этого
  `sub`) и дальше не трогается отсюда — иначе вход через Google на другой
  Google-почте молча перезаписывал бы то, что пользователь мог указать сам
  через `PATCH /users/me` (`services.update_profile`, единственный
  self-service путь для `User.email` после регистрации). Коллизия
  (`identity.email` уже занята другим `User.email`, поле уникальное) не
  роняет регистрацию — профиль просто остаётся без почты.
- **Регистрация — не `get_or_create` на `SocialLoginAccount`.**
  `SocialLoginAccount.user` — `NOT NULL` (связка без пользователя не имеет
  смысла), поэтому вместо `get_or_create(defaults={...})` (которому
  понадобилась бы промежуточная строка без `user`) — явные две ветки:
  найден `(provider, sub)` → использовать существующего `user`; не найден →
  создать `User`, затем `SocialLoginAccount` с уже готовым `user_id`.
- **Тот же SimpleJWT-контур, что OTP.** `complete_google_login` вызывает тот
  же приватный `_issue_token_pair` и публикует тот же топик
  `account.logged_in` (payload дополнен `method` — какой способ входа), что
  и `verify_otp` — с точки зрения остального кода (мидлварь, гейты,
  подписчики outbox) вход через Google неотличим от входа по OTP.
- **PKCE `_code_challenge`** — пять строк, продублированы из
  `apps.identity.services` (буквально та же формула ADR-062), не вынесены в
  `common/`: третьего потребителя нет, а зависимость между `apps.accounts`
  и `apps.identity` в любую сторону — уже существует (`apps.identity`
  импортирует `apps.accounts`, ADR-062) и оборачивать эти пять строк ради
  устранения дублирования смысла не имеет.

### Стартовый пакет согласий GLOBAL (`apps.social`)

- **`Consent.ConsentType.REPUTATION_HISTORY_BASIS`** — четвёртый тип,
  добавлен в общий (для всех контуров) справочник `Consent.ConsentType», а
  не только «для GLOBAL»: постановка прямо требует «с первого дня,
  ретроспективно не добавить» — раз тип согласия должен существовать с
  этого PR, он общий для модели, даже если пока запрашивается только в
  GLOBAL-регистрации.
- **`CONSENT_TEXT_VERSIONS` стал per-locale**: `{consent_type: {"ru": ...,
  "en": ...}}` вместо плоского `{consent_type: version}`. RU-версии
  (`"v1"`) не изменились — `_consent_text_version(consent_type, locale="ru")`
  — дефолт параметра `locale`, поэтому `complete_privacy_step`/`record_consent`
  без нового аргумента ведут себя ровно как раньше (RU-тесты 3.1 не
  редактировались). Текст согласий бэкенд не хранит нигде (только
  version-метка, ADR-067) — EN-версии сейчас `"v1-en-draft"` (болванки до
  Ю-23), это данные, не код.
- **`complete_global_privacy_step`** — отдельная функция, не переиспользует
  `complete_privacy_step` с доп. параметром: сигнатуры разные (4
  обязательных поля вместо 3), раздельные функции исключают риск случайно
  запросить RU-регистрацию без четвёртого согласия или GLOBAL — без него.
  Правило «без `pd_processing=True` регистрация не завершается»
  (152-ФЗ/ФЗ-156) сохранено — GLOBAL это правило не отменяет, только тексты
  становятся EN.
- **`GlobalPrivacyConsentsView`** (`POST /users/me/privacy-consents-global`) —
  отдельный эндпоинт, не режим существующего `PrivacyConsentsView`: тот же
  мотив (не менять форму ответа RU-эндпоинта, не давать RU-клиенту случайно
  запросить 4-польный контракт). `GET` отдаёт `GlobalConsentStateSerializer`
  (4 nullable-поля + `completed`) — «шаг согласий отдаёт 4 согласия EN»
  (✅ ГВ.2) читается буквально: ответ содержит 4 записи, `text_version`
  которых — EN.

## Отклонённые варианты

- **Один `PrivacyConsentsView`/`complete_privacy_step` с параметром
  `locale`/`consents: list[...]`.** Отклонено — гибкая сигнатура тут же
  открывает случай «GLOBAL-пользователь прислал только 3 согласия» или
  «RU-пользователь прислал 4», который пришлось бы валидировать отдельно;
  две явные функции с фиксированными наборами полей эту категорию ошибок
  устраняют на уровне сигнатуры.
- **`User.email` синхронизируется с Google-почтой на каждый вход.**
  Отклонено — стирает разницу между self-service `PATCH /users/me` и
  автоматическим значением от провайдера (тот же аргумент, что ADR-062 для
  `verified_full_name` vs `full_name_encrypted`): пользователь мог осознанно
  указать другую почту.
- **`SocialLoginAccount.user` — nullable, `get_or_create`.** Отклонено —
  нет ни одного легитимного состояния «связка есть, пользователя нет»;
  nullable-поле только ради `get_or_create` было бы даже более широким
  инвариантом, чем нужно (шире, чем то, что реально бывает).
- **State для Google несёт `user_id`, как ESIA.** Отклонено — на шаге
  `authorize-url` пользователя физически ещё нет для большинства входов
  (первый вход = регистрация); требовать `IsAuthenticated` для входа было
  бы противоречием в терминах.

## Последствия

- `apps.accounts` теперь выдаёт токены двумя путями (`verify_otp`,
  `complete_google_login`) через общий `_issue_token_pair` — будущий третий
  способ входа (если появится) добавляется тем же приёмом, без изменений в
  выдаче токенов.
- `apps.social.CONSENT_TEXT_VERSIONS`/`record_consent` — per-locale
  инфраструктура теперь общая: любое будущее приложение GLOBAL-EN текстов
  (не только регистрация) переиспользует `locale=` параметр, не изобретает
  свой.
- RU-регистрация (`complete_privacy_step`, `PrivacyConsentsView`) —
  байт-в-байт та же сигнатура и то же поведение; тесты 3.1 не редактировались.
