# ADR-086. `GET /v1/users/me`: хендл через `import_string`-композицию, не read-модель; JSON-ключ `display_name`, не `full_name`

**Статус:** принято
**Дата:** 2026-08-17
**Контекст этапа:** `docs/tasks/Задача_fix_web-profile-handle-real-api.md` — шаг онбординга
«Профиль» не сохранял handle/имя против боевого бэка (краш уже закрыт
`fix/web-consents-crash`, но функционально ничего не персистилось).

## Контекст

`GET /v1/users/me` (`apps.accounts.api.serializers.UserMeSerializer`) не отдавал
`handle`/`display_name` вовсе (только `full_name`, `apps.accounts.User`), а
`PATCH /v1/users/me` (`UserMeUpdateSerializer`) не принимал `handle` — DRF молча
игнорировал поле. Хендл (`Handle` модель) живёт в `apps.social`; `apps.accounts` —
нижний общий слой (как `apps.catalog`/`apps.jurisdictions`) и архитектурно НЕ имеет
права статически импортировать `apps.social` (CLAUDE.md, `docs/domain-model.md`,
import-linter: контракт «social зависит только от accounts» — направление
одностороннее, `backend/config/settings/base.py` уже прямо документирует это
рядом с `USER_ME_PROFILES_SELECTOR`).

## Решения

1. **Хендл в `/v1/users/me` — тем же приёмом, что уже есть для `profiles`:
   `import_string` по пути из настройки, не статический импорт.** Новая
   настройка `USER_ME_HANDLE_SELECTOR = "apps.social.selectors.get_active_handle_for_user"`
   (`backend/config/settings/base.py`, рядом с `USER_ME_PROFILES_SELECTOR`);
   `UserMeSerializer.get_handle` резолвит её в рантайме — статического импорта
   `apps.social` в `apps.accounts` как не было, так и нет (`uv run lint-imports`
   зелёный, 3/3 контракта). Значение — `"@value"` (с префиксом, не голое
   `value` как в `HandlePublicSerializer`/`Handle.value`) — фронт уже использует
   хендл как URL-сегмент (`OwnerProfilePage.tsx`, `/${me.handle}`,
   `ReputationCardPage.tsx` сверяет префикс `@` сам) — смена конвенции сломала
   бы уже рабочую навигацию по ссылке-хендлу.
2. **Read-модель (ADR-076, событийная, `outbox`-подписчик + денормализованное
   поле) НЕ применена — рассмотрена и отклонена.** ADR-076 оправдан там, где
   нужно ДЁШЕВО агрегировать МНОЖЕСТВО исторических событий в свою таблицу
   (карточка репутации — потоки `milestone.*`/`dispute.*`/`contract.completed`
   за всё время). Здесь задача — прочитать ТЕКУЩЕЕ единственное значение
   («мой хендл прямо сейчас»), которым и так уже владеет `apps.social`
   (`Handle.objects.filter(user=..., is_active=True)`) — событийный
   read-model с отдельной денормализованной колонкой в `apps.accounts.User`
   добавил бы миграцию, подписчика, `ProcessedEvent`-идемпотентность и
   ЭВЕНТУАЛЬНУЮ консистентность (задержка между `POST /users/me/handle` и тем,
   что увидит следующий `GET /users/me`) ради того, что прямой (пусть и через
   `import_string`, не «прямой импорт») синхронный вызов селектора даёт
   бесплатно и без задержки. Несоразмерная сложность для точечного чтения
   одной актуальной записи, не агрегата.
3. **Отдельный эндпоинт проверки занятости (`GET /users/handle-available`) НЕ
   заведён на боевом бэке.** Мок такой эндпоинт всегда имел (Ф1), но он
   МОК-ТОЛЬКО — реального `apps.social`-аналога никогда не было. Не строится
   и в этой задаче: «занятый/невалидный handle → понятная ошибка» (критерий
   готовности задачи) закрывается САБМИТ-временем — `POST /users/me/handle`
   и так возвращает `409 handle_taken`/`422 invalid_handle_format`
   (`apps.social.services.claim_handle`, уже покрыт тестами `apps/social/tests/`).
   Фронт (`useHandleAvailability`) на боевом бэке безопасно деградирует к
   `idle` (ошибка запроса не блокирует «Продолжить», см. комментарий в коде) —
   более раннюю живую обратную связь по мере набора можно добавить отдельной
   задачей, если продукту это будет нужно; изобретать новый публичный API
   ради этого сейчас — не по одному ⚠️ финдингу из уже загруженной задачи.
4. **JSON-ключ переименован `full_name` → `display_name` на ОБОИХ направлениях
   `/v1/users/me` (GET и PATCH), домен внутри (`User.full_name_encrypted`,
   `get_full_name`) НЕ переименован.** Выбор между этим и обратным (переименовать
   фронтовый `CurrentUser.display_name` → `full_name` везде) — решён в пользу
   МЕНЬШЕГО блаcт-радиуса: `display_name` на `CurrentUser` уже используется
   ~20 файлами фронта (`ActorSwitcher`, `OwnerProfilePage`, `AccountSettingsPage`,
   `ProfileSettingsPage`, `ContractPage` и т.д.) — их пришлось бы менять и
   заново вручную проверять каждый, вместо одного согласованного изменения на
   границе API (сериализатор + один существующий тест). В домен-модели
   (`docs/domain-model.md`) отдельного понятия «display name», отличного от
   `full_name`/`verified_full_name` для `User`, нет — терминологического
   конфликта это решение не создаёт, только имя поля на wire.

## Не рассматривалось

- **`apps.dashboards`-агрегация вместо расширения `/v1/users/me`.** `dashboards`
  (CLAUDE.md: «только selectors поверх остальных») — для дашбордов, не для
  identity/session-хаба; `/v1/users/me` — уже устоявшийся, широко потребляемый
  контракт, переезд на другой эндпоинт означал бы правку каждого потребителя
  `useCurrentUser()`, несоразмерно масштабу задачи.
- **GET-метод на `MyHandleView` (`apps.social`) для чтения своего хендла
  отдельным вызовом с фронта (композиция на клиенте, не на бэке).** Отклонено —
  `import_string`-приём уже есть и работает для `profiles` в этом же
  сериализаторе; заводить второй способ («часть данных из одного вызова, часть
  — из другого») ради того же результата без выгоды не имеет смысла.

## Последствия

- `CurrentUser.handle: string | null` (было `string`) — `null` до `POST
  /users/me/handle`. `CurrentUser.settings?: OwnerSettings` (было обязательным) —
  реальный `/v1/users/me` настроек приватности пока не отдаёт вовсе (отдельный,
  не закрытый в этой задаче пробел, см. `docs/tasks/
  Задача_fix_web-profile-handle-real-api.md` §5 и комментарии в коде —
  `PrivacySettingsPage.tsx` функционально всё ещё бьёт в несуществующий
  `PATCH /users/me/settings`).
- Фронт: `useClaimHandle` (`POST /users/me/handle`) — НОВЫЙ, отдельный от
  `useUpdateProfile` (`PATCH /users/me`, теперь пишет только `display_name`/
  `email`/`country_code`/`locale`, БЕЗ `handle`). `ProfileStepPage.tsx` шлёт
  хендл ПЕРВЫМ и ОТДЕЛЬНО от имени — при 409/422 шаг не «полусохраняется»
  (имя ещё не отправлено).
- `ProfileSettingsPage.tsx` (DEV-02, настройки → профиль, вне онбординга) НЕ
  тронута — она тоже шлёт `handle` через `useUpdateProfile`/PATCH и тоже
  реально ничего не сохранит на боевом бэке; вместе с `about`/`city`/`remote`/
  `spheres`/`avatarUrl` (тоже отсутствуют в `UserMeSerializer`) это отдельный,
  более крупный системный разрыв (см. итоговый отчёт задачи), сознательно
  не закрыт в этом PR (§5 задачи: «если найдётся — вынести отдельно»).
