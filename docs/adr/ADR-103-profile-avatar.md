# ADR-103. Фото профиля: своя уменьшенная копия, Google — только стартовое значение

Дата: 2026-08-21. Статус: принято. Закрывает Tier B «`avatarUrl`» из ADR-087.
Ветки: `feat/profiles` (бэкенд), `feat/web-profile-avatar` (фронт).
Постановка: `docs/tasks/Задача_feat_profiles-avatar.md`.

## Контекст

Google-вход (ADR-071) получает `picture` из userinfo, но мы его выбрасываем;
`Profile` знает только `avatar_visibility` (ADR-059/067) — «кто видит», без
самого изображения. Нужно: подтягивать фото из Google при регистрации, дать
менять/удалять, хранить **маленькую** копию у себя.

## Решение

1. **Храним только свою копию.** При любом источнике (Google или загрузка)
   исходник проходит через Pillow: проверка формата, EXIF-transpose, сброс всех
   метаданных (EXIF/GPS), центр-кроп в квадрат, два размера — 256 и 64 px,
   WebP. В S3-совместимом бакете `PROFILE_AVATAR_BUCKET_NAME` лежат
   `avatars/<profile_id>/<uuid7>/256.webp` и `.../64.webp`. Ссылка Google CDN
   наружу не отдаётся и в БД не хранится: она протухает, раскрывает способ
   входа и тянет внешний хост для РФ-пользователей.
2. **Google — стартовое значение, не синхронизация.** `avatar_source_url`
   едет в payload `account.logged_in` только при `created=True`; подписчик
   `apps.profiles` после создания person-профиля ставит Celery-задачу
   `fetch_external_avatar`. Задача ничего не делает, если фото уже есть
   (`avatar_key != ""`). Повторные логины фото не трогают; удалённое
   пользователем фото из Google не возвращается (повторного импорта нет).
   Ошибки сети — тихий выход, без ретраев: фото не критично для входа.
3. **Модель.** `Profile.avatar_key` (префикс объектов, `""` — нет фото),
   `avatar_source` (`none`/`upload`/`google`), `avatar_updated_at`. Замена и
   удаление физически удаляют старые объекты из бакета — это ПД, мягкого
   удаления нет (CLAUDE.md); crypto-shredding не нужен, данных в БД нет.
4. **Раздача через наш эндпоинт**, не через публичный бакет:
   `GET /profiles/{id}/avatar?size=256|64&v=<версия>&t=<подпись>`.
   `avatar_visibility=public` → отдаётся любому (`t` игнорируется, `v` —
   cache-buster). `deals_only` → владельцу/представителю по JWT либо по
   подписанному `t` (`TimestampSigner`, salt `profiles.avatar`, TTL
   `PROFILE_AVATAR_URL_TTL_SECONDS`, 7 суток): `<img>` не шлёт Authorization,
   поэтому контрагент получает подписанную ссылку в JSON, а не токен в
   заголовке. Нет фото / нет права — 404 (приватное не раскрывает существование).
5. **Кто формирует `avatar_url`.** `ProfileSerializer` — по зрителю из
   `context["request"]` (владелец/представитель → `can_act_as`; контрагент →
   `settings.PROFILE_AVATAR_COUNTERPARTY_SELECTOR` = `apps.reputation.selectors.
   is_counterparty` через `import_string`, иначе цикл profiles↔reputation);
   `ProfileSummarySerializer` (`/users/me`) — владелец, всегда подписанная
   ссылка; `ReputationCardView` — по уже посчитанному `card_visible_in_full`.
6. **Хранилище — тумблер `PROFILE_AVATAR_STORE=fake|s3`** (как
   `GOOGLE_LOGIN_PROVIDER`): `fake` — память процесса (тесты/локалка),
   прод обязан выставить `s3` (в `прод-конфиг` добавлена переменная).
7. **Лимиты — настройки**, не константы: `PROFILE_AVATAR_MAX_UPLOAD_BYTES`
   (5 МБ), `PROFILE_AVATAR_MAX_SOURCE_PIXELS` (40 Мпикс, защита от
   decompression bomb), `PROFILE_AVATAR_FETCH_TIMEOUT_SECONDS`.

## Последствия

- Новая зависимость `pillow` в `backend/pyproject.toml`.
- Новые эндпоинты `POST/DELETE/GET /profiles/{id}/avatar`; в трёх
  сериализаторах появляется `avatar_url: string | null`.
- Фронт: `ProfileSettingsPage` получает «Сменить фото»/«Удалить фото»;
  `PassportHeader` в `/me` и `/@handle` показывает реальное фото.
- Отложено: кроп на клиенте, бизнес-профили (логотип юрлица — тот же
  механизм, право уже учтено через `manage_profile`, UI пока только для
  person), CDN-инвалидация (URL версионирован `v=`, отдельной инвалидации
  не нужно).
