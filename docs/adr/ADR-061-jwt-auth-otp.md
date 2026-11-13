# ADR-061. Аутентификация: JWT (SimpleJWT) + OTP по телефону

**Статус:** принято
**Дата:** 2026-07-25
**Контекст этапа:** 3.1 (`accounts`)

## Контекст

tech-spec.md §7.2 задаёт требования (собственный OAuth 2.1-совместимый
auth-сервер, access JWT 15 мин (ADR-108: 60 мин), refresh 30 дней с ротацией и привязкой к
устройству, вход телефон+SMS-код с фейковым провайдером в dev/тестах), но не
фиксирует конкретную библиотеку/реализацию — это первое приложение,
реализующее аутентификацию, решение нужно принять здесь.

## Решение

- **`djangorestframework-simplejwt`** (+ его встроенное приложение
  `token_blacklist`) вместо самодельной JWT-обвязки или `django-oauth-
  toolkit`: закрывает ротацию + блэклист «из коробки»
  (`SIMPLE_JWT = {"ROTATE_REFRESH_TOKENS": True, "BLACKLIST_AFTER_ROTATION":
  True, ...}`, `config/settings/base.py`), не требует OAuth2-обвязки
  (клиенты/scopes), которая здесь не нужна — API только для собственных
  мобильного/веб-клиентов, не для сторонних OAuth-интеграторов.
- **Ротация и «привязка к устройству».** `apps.accounts.services.
  refresh_token_pair()` использует встроенный механизм SimpleJWT:
  предъявленный refresh-токен блэклистится (`OutstandingToken`/
  `BlacklistedToken`, таблицы `token_blacklist`), выдаётся новая пара.
  Повторное предъявление уже провёрнутого refresh — `RefreshTokenInvalidError`
  → HTTP 401 `refresh_token_invalid`. `UserDevice`/`DeviceKey` (регистрация
  устройства и его публичного ключа push-уведомлений) — самостоятельные
  сущности, управляемые отдельными эндпоинтами (`POST /users/me/devices`,
  `POST /users/me/devices/{id}/device-key`), НЕ участвуют в связывании самого
  refresh-токена с конкретной записью устройства: это разные заботы
  (сессия vs. push-адресация), совмещать их в одном flow было бы
  преждевременной связанностью.
- **OTP-вход.** `apps.accounts.providers.SMSGateway` — Protocol,
  `FakeSMSGateway` — единственная реализация (CLAUDE.md: «внешние
  провайдеры — только интерфейсы + фейки», реальной SMS-интеграции нет и
  не планируется в 3.1). Код — фиксированный в dev/тестах
  (`settings.OTP_FIXED_CODE = "111111"`), случайный 6-значный в проде
  (`OTP_FIXED_CODE` не задан). Хранение кода — Redis (`django.core.cache`,
  `CACHES["default"]`), TTL 5 минут, хешируется (`sha256`) перед записью в
  кеш. Rate-limit — тоже через Redis: не более
  `OTP_REQUEST_LIMIT=3` запросов кода за 10 минут и не более
  `OTP_VERIFY_ATTEMPT_LIMIT=5` попыток проверки на один код, оба — простой
  fixed-window счётчик поверх `cache.incr()`.
- **Ошибки — application/problem+json** (tech-spec.md §7.5) через общий
  `common.api.exceptions.problem_json_exception_handler`
  (`REST_FRAMEWORK["EXCEPTION_HANDLER"]`) — не специфично для accounts,
  но введено в этом PR, так как раньше в проекте не было ни одного
  DRF-эндпоинта. Домен-специфичные коды (`otp_invalid_code`,
  `otp_rate_limited`, `refresh_token_invalid`, `device_not_found`, …)
  поднимаются как `common.api.exceptions.DomainAPIError` во view-слое —
  сами services.py ничего не знают об HTTP (CLAUDE.md: бизнес-логика не в
  api/, но и не должна знать о transport-специфичных статусах).

## Отклонённые варианты

- **Django-сессии/CSRF** — не подходят: мобильный клиент, stateless API.
- **`django-oauth-toolkit`/полноценный OAuth2-сервер** — избыточен для
  первого клиента (нет сторонних интеграторов, которым нужны
  client_id/scopes); при необходимости ЕСИА-интеграции (этап 3.2) она
  реализуется отдельным flow (`/auth/esia/*`), не через OAuth2-toolkit.
- **Самодельные JWT без библиотеки** — отклонено: ротация+blacklist+
  безопасная проверка подписи/exp — решённая задача, дублировать её выше
  риск ошибки, чем выигрыш в контроле.

## Последствия

- Новая обязательная зависимость `djangorestframework-simplejwt`, новые
  таблицы `token_blacklist_*` (миграции библиотеки, не редактируются).
- `AUTH_USER_MODEL = "accounts.User"` — фиксируется в этом PR, это первая
  и единственная точка, где он может быть установлен (Django не позволяет
  сменить `AUTH_USER_MODEL` после первой миграции с FK на пользователя).
