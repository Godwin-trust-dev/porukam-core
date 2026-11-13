# ADR-201. Guard прод-настроек: production не стартует на fake-дефолтах

**Статус:** принято (веха публикации кода, аудит 2026-11)
**Контекст:** `backend/config/settings/prod_guard.py`, `production.py`, `base.py`, прод-compose и шаблон прод-окружения (закрытый каталог развёртывания)
**Номер:** 201 (зарезервирован владельцем).

## Контекст

Код проекта становится публичным (зеркало). В `settings/base.py` все внешние провайдеры по
умолчанию `fake` (push, email, TSA, хранилища аватаров/доказательств/архива, Drive, вход
через Google), а прод-профиль этого не проверял. Самое опасное: `GOOGLE_LOGIN_PROVIDER=fake`
принимает «код» вида `sub|email` и пускает под любым адресом — при забытой переменной в
прод-.env публичный код превращает это в тривиальную атаку. `OTP_FIXED_CODE`, если задан,
делает код входа известным всем и отдаёт его в ответе (`dev_hint`). Прод уже однажды молча
работал на fake-хранилищах (compose пробрасывает env явным списком, забытая строка = дефолт).

## Решение

1. `config/settings/prod_guard.py` — чистая функция над Mapping настроек
   (`collect_production_violations`) и `enforce_production_settings`, бросающая
   `ImproperlyConfigured` со списком ВСЕХ нарушений сразу. Вызывается в конце
   `production.py` при импорте настроек: это срабатывает для gunicorn/daphne, celery
   worker/beat и `manage.py migrate` (во всех прод-сервисах и в Dockerfile задан
   `DJANGO_SETTINGS_MODULE=config.settings.production`).
2. Жёсткие запреты (не обходятся ничем): `GOOGLE_LOGIN_PROVIDER != real`; любой
   `OTP_FIXED_CODE`; `SECRET_KEY` пустой, короче 32 символов или с `change-me`/`insecure`;
   `PHONEBOOK_HASH_PEPPER` с `change-me`; `DEBUG=True`; `*` в `ALLOWED_HOSTS`; неизвестное
   имя в клапане (опечатка не должна молча «не сработать»).
3. Мягкие запреты — любой провайдер/хранилище не в «боевом» значении: email (`resend`),
   push (`webpush`, либо задан `NOTIFICATIONS_NATIVE_PUSH_PROVIDERS`), TSA (`rfc3161`),
   `PROFILE_AVATAR_STORE`/`EVIDENCE_OBJECT_STORE`/`ARCHIVE_OBJECT_STORE` (`s3`), Drive
   (`real`), `GROUP_LOGO_STORE` (если задан — `s3`); а также `PHONE_LOGIN_ENABLED=true`,
   поскольку реального SMS-шлюза в проекте нет (`FakeSMSGateway`). Фейковый SMS допустим,
   пока вход по телефону выключен.
4. Клапан `PROD_ALLOW_FAKE_PROVIDERS` (имена настроек через запятую, `SMS_GATEWAY` для
   телефонного входа) снимает ТОЛЬКО мягкие запреты и только перечисленных провайдеров —
   аварийно, чтобы владелец мог выкатиться без простоя. В норме пуст; после выкатки
   переменную убрать. Google-вход и `OTP_FIXED_CODE` клапаном не обходятся.
5. Двойная защита `dev_hint`: `production.py` ставит `PRODUCTION_PROFILE=True`, и views
   `auth/otp/request`, `auth/email/request` не отдают код в ответе в production, даже если
   `OTP_FIXED_CODE` задан (guard при этом не даст стартовать).
6. Compose: у `GOOGLE_LOGIN_PROVIDER` убран дефолт `:-fake` (пусто — guard ловит забытую
   переменную); `PROD_ALLOW_FAKE_PROVIDERS` добавлен во все три Django-сервиса
   (core, celery_worker, celery_beat). Остальные `:-fake` оставлены: они совпадают с
   дефолтами settings и теперь ловятся guard-ом, а локальный compose без .env не меняется.
   `OTP_FIXED_CODE` compose не пробрасывает вовсе.
7. `manage.py`/`celery.py` по умолчанию остаются на `config.settings.local` (удобство
   разработчиков); прод задаёт `production` явно (compose ×3, Dockerfile `ENV`).

## Что проверить при деплое

Таблица «переменная → ожидаемое значение» — в шаблоне прод-окружения (блок «Guard»).
Перед выкаткой сверить прод-.env на ВМ: `GOOGLE_LOGIN_PROVIDER=real`, `OTP_FIXED_CODE`
отсутствует, `PHONE_LOGIN_ENABLED=false`, все `*_PROVIDER`/`*_STORE` боевые (в том числе
`PROFILE_AVATAR_STORE=s3`, `ARCHIVE_OBJECT_STORE=s3`, `EVIDENCE_DRIVE_PROVIDER=real`),
`DJANGO_SECRET_KEY` и `PHONEBOOK_HASH_PEPPER` случайные. Если контейнер падает при старте —
читать лог: текст исключения перечисляет все нарушения.

## Последствия

Минус: ошибка в прод-.env теперь роняет сервис при старте вместо тихой работы на fake —
это сознательный обмен (fail closed). Остаточный риск: `WORM_MODE=none` guard не проверяет
(не провайдер, а режим; в .env.example прод — `bucket_lock`).
