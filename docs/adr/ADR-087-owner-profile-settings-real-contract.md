# ADR-087. Профиль-хаб владельца против боевого бэка: где что реально живёт (Tier A выполнен, Tier B отложен)

**Статус:** принято
**Дата:** 2026-08-17
**Контекст этапа:** `docs/tasks/Задача_fix_web-profile-settings-real-api.md` — продолжение
ADR-086 (`fix/web-profile-handle-real-api`): `ProfileSettingsPage`/`PrivacySettingsPage`
(и часть `OwnerProfilePage`) писали/читали поля, которых на боевом бэке либо нет вовсе,
либо они живут в другом приложении под другим именем/enum'ом.

## Контекст

Полная инвентаризация `CurrentUser`-полей, использовавшихся этими тремя экранами,
против реального бэка (`git grep` по моделям/сериализаторам `apps.accounts`/
`apps.profiles`/`apps.social`):

| Поле фронта | Реальный дом | Статус |
|---|---|---|
| `display_name`, `email`, `country_code` | `apps.accounts.User` | ✅ уже реален (`PATCH /v1/users/me`, ADR-086) |
| `handle` | `apps.social.Handle` | ✅ уже реален (`POST /v1/users/me/handle`, ADR-086) |
| `city`(`city_name`), `remote`(`works_remotely`) | `apps.profiles.Profile` | ✅ Tier A (эта задача) — `GET`/`PATCH /v1/profiles/{id}` УЖЕ существовали |
| `privacy.cardVisibility`(`profile_visibility`) | `apps.profiles.Profile` | ✅ Tier A — тот же `PATCH /v1/profiles/{id}`, enum РЕАЛЬНО `public`/`link_and_deals` (был вымышленный `everyone/contacts/nobody`) |
| `privacy.hideFromCatalog`(`hide_from_catalog`) | `apps.profiles.Profile` | ✅ Tier A |
| «Показывать только @handle» (`show_name`, ИНВЕРТИРОВАННЫЙ) | `apps.profiles.Profile` | ✅ Tier A |
| `privacy.avatarVisibility`(`avatar_visibility`) | `apps.profiles.Profile` | ✅ Tier A — enum `public`/`deals_only` (был вымышленный `visibleFields.photo: boolean`) |
| `privacy.findableByPhone` | `apps.social.Consent` (`phone_discoverability`) | ✅ Tier A — `GET`/`POST /v1/users/me/consents` УЖЕ существовал (не поле `Profile`!) |
| `about` (био) | — | ❌ Tier B — поля нет НИГДЕ на бэке |
| `avatarUrl` (реальная загрузка) | — | ❌ Tier B — только `avatar_visibility` (enum «кто видит»), самого изображения/загрузки нет вообще |
| `spheres` (заявленные сферы) | — | ❌ Tier B — есть только `PortfolioProject.sphere` (сфера ОДНОГО проекта портфолио), не декларация сфер профиля целиком |
| `privacy.visibleFields.phone`/`.portfolio`, `privacy.cityPrecision` | — | ❌ Убраны, не Tier B — вымышлены на 100%, даже не соответствуют ADR-059 §5 (телефон «скрыт всегда», не тумблер; точность города — только «город», district/hidden не решались) |

## Решения

1. **Tier A выполнен ЦЕЛИКОМ в этом PR, БЕЗ бэкенд-изменений.** Все нужные для Tier A
   эндпоинты (`PATCH /v1/profiles/{id}`, `GET/POST /v1/users/me/consents`) уже
   существовали и уже были протестированы бэкенд-тестами — гэп был только во
   фронте (не туда бьёт, не те имена/enum'ы). Экономит цикл «спроектировать бэк →
   реализовать → фронт» для половины симптома.
2. **`CurrentUser` больше НЕ несёт `settings`/`avatarUrl`/`city`/`remote`/`spheres`/
   `about`.** Эти поля никогда не были в реальном `/v1/users/me` (только в моке Ф1).
   Введены `OwnerProfileSettings` (city_name/works_remotely/profile_visibility/
   hide_from_catalog/show_name/avatar_visibility — `apps.profiles.Profile`,
   `useOwnProfileSettings`/`useUpdateOwnProfileSettings`) и обычные consents-хуки
   (`useMyConsents`/`useRecordConsent`, `apps.social`). `findOwnPersonProfileId`
   находит id собственного person-профиля из `CurrentUser.profiles` (уже приходит
   через `import_string`-композицию, ADR-086) — второго похода за профилем не нужно.
3. **`ProfileVisibility` (уже существовавший тип, `packages/core`) переиспользован**
   вместо нового `CardVisibility` — тот же `'public'|'link_and_deals'`, что и в
   онбординге (`VisibilityChoice`). Дублировать тип с идентичными значениями под
   другим именем не стали.
4. **`show_name` — ИНВЕРТИРОВАН на UI** (`showHandleOnly = !show_name`): реальное
   поле хранит «показывать имя» (дефолт `true`), фронтовый тумблер исторически
   называется «показывать только хендл» — сохранили формулировку тумблера
   (привычна пользователю, совпадает с онбордингом), инвертировали на границе.
5. **Onboarding (`ProfileStepPage.tsx`, ADR-086) тоже починен «заодно»** — тумблер
   «Показывать только @handle» там раньше слал в несуществующий `PATCH /users/me/
   settings` (обёрнуто в `try/catch`, молча глотался). Теперь — тот же реальный
   `PATCH /profiles/{id}` (`show_name`), с той же инфраструктурой (`findOwnPersonProfileId`/
   `useUpdateOwnProfileSettings`), что и `PrivacySettingsPage`. Не блокирует
   продолжение онбординга при ошибке (тумблер можно перевключить позже).
6. **Обнаружен и исправлен таймингOвый баг мока, вскрытый этим же изменением:**
   `authGlobalDb.ts:freshUser()` держал `profiles: []` до заявки хендла (старое,
   неверное предположение, унаследованное из ADR-086) — но РЕАЛЬНЫЙ бэк заводит
   person-профиль ПРИ РЕГИСТРАЦИИ (подписчик `apps.profiles` на `account.logged_in`,
   `backend/apps/profiles/subscriber.py`, ДО любого шага онбординга). Мок исправлен
   (`freshUser` теперь сразу с одним person-профилем); `claimHandle` (мок) теперь
   синхронизирует `handle` И на `me.handle`, И на `me.profiles[].handle` (было —
   только создавал профиль «если профилей ещё нет», что перестало срабатывать
   вообще, раз профиль уже существует).
7. **Tier B — НЕ реализован, скрыт в UI, задокументирован здесь как контракт для
   будущей задачи** (заголовок §4 задачи требовал согласования объёма — оставлено
   явно отложенным, не «есть поле — молча не сохраняется»):
   - `ProfileSettingsPage.tsx`: убраны блок аватар-загрузки (файловый инпут,
     replace/remove), поле «О себе», чипы сфер.
   - `PrivacySettingsPage.tsx`: убраны «Видимость полей» (телефон/фото/портфолио
     по отдельности) и «Точность города» — ни то, ни другое никогда не было
     реальным даже в постановке ADR-059 (сверено буквально с §5/§6 того ADR).
   - Для БУДУЩЕЙ реализации Tier B: `about` — тривиально (`TextField` на
     `apps.profiles.Profile`, одна миграция); `spheres` (декларация, не per-проект)
     — нужно решить, это НОВОЕ поле `Profile.declared_spheres: list[str]` или
     что-то, вычисляемое из `PortfolioProject.sphere` агрегированно (открытый
     вопрос, не решается здесь); `avatarUrl` — самый крупный кусок, реальная
     загрузка изображения (нужен S3-эндпоинт, вероятно EXIF-очистка по аналогии
     с уже существующим evidence-пайплайном, `common`/`apps.evidence`).

## Не рассматривалось

- **Полная замена `OwnerProfilePage.tsx`'s "пустой профиль" эвристики на что-то
  умнее одного поля.** `isEmptyProfile` теперь смотрит только на `city_name` (было
  `about`+`spheres`+`city`, все три поля кроме city — Tier B). Слабее сигнал, но
  честнее: показывать подсказку «заполните профиль», ссылающуюся на поля, которых
  либо нет, либо они не сохранятся — хуже, чем менее точный, но рабочий сигнал.
- **Отдельный `GET`-эндпоинт проверки занятости handle для этой страницы.**
  Не нужен — `useHandleAvailability` (мок-only, деградирует безопасно) и
  `useClaimHandle` (реальный, 409/422 на сабмите) уже полностью закрывают
  требование задачи «занятый/невалидный handle → понятная ошибка» (ADR-086).

## Последствия

- Бэкенд НЕ тронут вообще в этом PR — только фронт (`packages/core`, `web/`) +
  мок-слой (`web/src/mocks/profilesDb.ts`/`profilesHandlers.ts` — новые файлы,
  `POST/GET /v1/users/me/consents` — добавлены в `profileHandlers.ts`).
- `docs/tasks/Задача_fix_web-profile-settings-real-api.md` §4 («уточнить скоуп
  запуска») закрыт решением пользователя: Tier A — в этом PR, Tier B — отдельная
  будущая задача с контрактом, зафиксированным в таблице выше.
