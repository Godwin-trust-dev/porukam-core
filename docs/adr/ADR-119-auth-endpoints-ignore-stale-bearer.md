# ADR-119: Контур входа/refresh не аутентифицирует по Bearer; стандартные ошибки — на языке клиента

Дата: 2026-08-24. Статус: принят. Поправка к ADR-061 (JWT), ADR-107/108 (сессия и refresh).

## Контекст

Отсмотр 2026-08-24 (docs/backlog.md, «Комментарии пользователя»): «долго не работала в
приложении на десктопе, пришла к открытой вкладке. Не даёт переключиться, на всех вкладках
выдаёт `code: authentication_required` (на английском)… почему протухла аутентификация?
клиент не вышел… либо перевёл на вход, но не завис».

Разбор. Access живёт 60 минут (ADR-108), refresh — 30 дней с ротацией. Клиент
(`packages/core/src/api/client.ts`) держит пару в localStorage и по 401 сам зовёт
`POST /auth/token/refresh`. Но `ApiClient.send` ставит `Authorization: Bearer <access>`
на **все** запросы, включая refresh, logout и повторный вход, а
`DEFAULT_AUTHENTICATION_CLASSES = [JWTAuthentication]` действует и на `AllowAny`-вьюхи:
DRF аутентифицирует запрос в `initial()` **до** проверки прав, и **протухший** Bearer
роняет сам запрос — `401 authentication_required`, не `refresh_token_invalid`.

Подтверждено тестами (`apps/accounts/tests/test_api.py::test_*_ignores_stale_bearer_header`,
красные до фикса): с истёкшим access `/auth/token/refresh`, `/auth/logout` и
`/auth/otp/request` отвечали 401.

Следствие для фронта:
- до ADR-108 любой 4xx на refresh = «сессия мертва» → logout → «выбрасывает на вход»
  ровно через час после входа (жалобы 2026-08-18…22);
- после ADR-108 только `refresh_token_invalid` = приговор, прочие 4xx = «недоступно» →
  клиент честно НЕ разлогинивает, но и обновить пару не может → каждый экран показывает
  `ErrorState` с `code: authentication_required`, «Повторить» бьёт в ту же стену,
  а повторный вход с этим же Bearer тоже 401 — зависание.

Вторая часть замечания — «на английском»: для стандартных DRF-исключений
(`NotAuthenticated`, `PermissionDenied`, `NotFound`, `Throttled`, `ValidationError`, …)
`problem_json_exception_handler` ставил `title = code`. Локализовался только `title`
`DomainAPIError`-ветки (ADR-075/077), а именно стандартные коды человек видит чаще всего.

## Решения

### 1. Бэк: `authentication_classes = []` на контуре входа/выхода/refresh

`_AnonymousAuthView` (`apps/accounts/api/views.py`): `OTPRequestView`, `OTPVerifyView`,
`GoogleAuthorizeUrlView`, `GoogleCallbackView`, `TokenRefreshView`, `LogoutView`.
Предъявитель здесь — refresh/код в теле; Bearer не нужен и не читается, протухший —
не мешает. Это делает поведение независимым от клиента (PWA, старые бандлы, curl).

### 2. Бэк: `title` стандартных ошибок — на языке запроса

`_standard_title(code, request)`: RU — встроенный реестр `ERROR_TITLES_RU_STANDARD`
(без похода в БД, как и RU-ветка `DomainAPIError`); прочие языки — пакет языка
(`apps.l10n.get_error_title`, `errors.<code>`, уже есть во всех 29 пакетах) →
`ERROR_TITLES_EN_STANDARD` → сам код. `code` по-прежнему не локализуется (§7.5).
Тексты реестров = тексты `l10n/packs/{ru,en}.json → errors` — один источник смысла.

### 3. Фронт (парный PR `fix/web-stale-session-recovery`)

- `ApiClient.send` не ставит `Authorization` на `/auth/*` (страховка для старых бэков);
- `doRefresh`: **любой** 401 на `/auth/token/refresh` — приговор (`rejected` → logout →
  `RequireAuth` → `/welcome`): 401 на этот путь может дать только бэк, Cloudflare-челлендж и
  обрывы — 403/5xx/сеть и остаются `unavailable`;
- `ErrorState` показывает человекочитаемый `problem.title` (теперь на языке клиента) рядом с
  кодом, а не один код.

## Последствия

- Сессия обновляется молча каждый час до 30 дней; по истечении refresh — честный уход на
  вход, не зависание. Старые бандлы с Bearer на refresh тоже начинают работать после деплоя
  бэка (§1) — деплой бэка первым.
- Тексты стандартных ошибок для RU берутся из кода, а не из пакета: правка текста — правка
  реестра (и `l10n/packs/ru.json` для единообразия).
