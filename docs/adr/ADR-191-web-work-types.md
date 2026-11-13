# ADR-191. Виды работ («подсферы») на фронте — профиль и поиск

**Статус:** принято (фронт-часть задачи, бэкенд — ADR-190).
**Номер:** 191 — сверено по репозиторию и всем ворктри (`ls docs/adr ~/porukam-worktrees/*/docs/adr
| grep -o 'ADR-[0-9]*' | sort -u | tail`, максимум занятый — 190).

## Постановка владельца (дословно, см. ADR-190)

> давай ещё дадим возможность в профиле и поиске указывать подсферы

> подожди… не надо так. пусть через поиск сферу находят. а ниже к сфере выдаётся перечень видов
> работ. как у нас в договоре. не усложняй

## Контекст

ADR-190 подготовила бэкенд: `GET /v1/work-types?sphere=` отдаёт человекочитаемые названия видов
работ (4 кода `other.*` без подписи исключены навсегда), `Profile.work_type_codes` — плоский
список составных кодов `<сфера>.<категория>` (≤ 30, `PATCH`/`GET /v1/profiles/{id}`, тем же полем,
что `sphere_codes`), инвариант «нельзя выбрать вид работ незаявленной сферы» (422
`work_type_sphere_not_declared`, плюс `invalid_work_type`/`profile_work_types_limit`), поиск —
повторяемый `work_type=` у `GET /v1/dashboard/search` (ИЛИ между значениями, И с `sphere`/гео/
опытом, независимо от них). Эта ветка — фронт поверх готового API: ОДИН компонент «сфера → её
виды работ», как просил владелец, «как в мастере договора» (`SphereStep.tsx`, где под выбранной
сферой уже разворачивается список её видов работ — только там выбор ОДИНОЧНЫЙ, для рекомендаций
чек-листа, а не множественный список профиля/поиска).

## Решение

### `WorkTypeChipsEditor` — общий компонент, живёт рядом с `SphereChipsEditor`

`web/src/features/profile/WorkTypeChipsEditor.tsx` — новый компонент по образцу
`SphereChipsEditor.tsx`/`SphereStep.tsx`: принимает `spheres: string[]` (ТЕКУЩИЙ список
сфер вызывающей стороны — то же значение, что уже держит `SphereChipsEditor`), `value`/`onChange`
(составные коды `<сфера>.<категория>`) и рендерит под КАЖДОЙ сферой из `spheres` список её видов
работ (`GET /v1/work-types?sphere=`, через `useQueries` + вынесенный `workTypesQueryOptions`
из `features/contractNew/api.ts` — тот же общий кэш, что у мастера договора: разворачивание
одной и той же сферы в договоре и в профиле не бьёт по сети дважды). Каждый вид работ — простой
тумблер (`aria-pressed`), не чипы с крестиком: клик по невыбранному добавляет, по выбранному —
убирает, множественный выбор без второго уровня поиска внутри списка (владелец: «не усложняй») —
никакого нового справочника, никакого отдельного экрана.

Компонент используется НЕИЗМЕНЁННЫМ в двух местах:
- `ProfileSettingsPage.tsx` — под `SphereChipsEditor`, `spheres` = заявленные сферы,
  `value`/`onChange` — локальный стейт `workTypes`, уходящий тем же `PATCH /profiles/{id}` полем
  `work_type_codes`, что и `sphere_codes`.
- `SearchPage.tsx` (панель фильтров каталога, ADR-184/185/189) — под фильтром сфер,
  `spheres` = `catalogFilters.spheres` (из URL), `value`/`onChange` — параметр `work_type=` URL.

Без сфер компонент рендерит `null` (нечего разворачивать) — то же правило, что заставляет
`SphereChipsEditor` тоже не показывать пустых секций.

### Снятие сферы снимает её виды работ — но ответственность НЕ на компоненте

Первая версия компонента чистила `value` сама (внутренний `useEffect`, убирающий из `value` коды,
чьей сферы больше нет в `spheres`). Это оказалось НЕВЕРНО для поиска: прямая ссылка
`/search?work_type=repair.repair_kitchen` БЕЗ `sphere=repair` в том же URL — валидный независимый
фильтр (ADR-190 §3: сфера и вид работ друг друга не проверяют специально, оба матчатся отдельно и
объединяются через И) — но компонент, видя `spheres=[]` при первом же рендере, тут же вызывал
`onChange([])`, стирая параметр из URL ДО того, как человек вообще коснулся панели. Баг найден
тестом (`SearchCatalogFilters.test.tsx`, сценарий «один вид работ в URL» — таймаут на
`search-catalog-list`, реальный сетевой запрос улетал с `work_type=`, но React-состояние URL уже
не содержало параметр к моменту рендера).

**Решение** — компонент НЕ трогает `value` сам, `spheres` влияет только на то, какие группы
видны. «Снятие сферы снимает её виды работ» — обработчик `onChange` САМОГО `SphereChipsEditor` у
каждого потребителя:
```ts
// ProfileSettingsPage.tsx / SearchPage.tsx (в обработчике сфер)
setWorkTypes((codes) => codes.filter((c) => nextSpheres.includes(c.split('.')[0] ?? '')));
```
Это срабатывает ТОЛЬКО на явное действие «убрать сферу» через чип, не на монтирование/прямую
ссылку — прямой URL с одним `work_type=` остаётся рабочим, а видимое поведение («убрал сферу —
пропали её виды работ») выполняется именно тогда, когда владелец его описывал: по факту снятия.

### Профиль: `work_type_codes` — тем же PATCH, что сферы

`packages/core/src/api/types.ts` — `OwnerProfileSettings.work_type_codes: string[]`;
`features/profile/api.ts` — `OwnerProfileSettingsPatch` получил `work_type_codes` в `Pick`.
`ProfileSettingsPage.tsx` — состояние `workTypes`/`workTypesDirty` рядом с `spheres`/`spheresDirty`
(та же логика: вне react-hook-form, отдельный «грязный» флаг для блокировки навигации), сохранение
— тем же `Promise.all`, что город/сферы/регион работы. Три новых 422 (`profile_work_types_limit`,
`work_type_sphere_not_declared`, `invalid_work_type`) — человекочитаемый текст в
`profile.workType.{limit,sphereNotDeclared,invalid}` (тот же приём, что `work_area_limit`/
`work_area_duplicate`), отображается `<p role="alert" data-testid="work-types-save-error">`.

### Поиск: `work_type=` — независимый фильтр в URL, как `sphere`

`features/search/api.ts` — `CatalogSearchFilters.workTypes: string[]`, участвует в
`catalogFiltersActive` (выбранный вид работ — тоже фильтр, включает каталог наравне с гео/сферой/
опытом, ADR-189 «не показывай никого, пока не задан фильтр»), уходит в `work_type=` (повторяемый
параметр) и `probeCatalogNonEmpty`/`useCatalogSearch`, сортируется перед попаданием в `queryKey`
(тот же приём, что сферы — порядок значений не должен считаться новым запросом). `SearchPage.tsx`
читает `searchParams.getAll('work_type')`, рендерит `WorkTypeChipsEditor` ПОД строкой
`.catalogFilters` (своя строка — список видов работ у нескольких сфер сразу шире одной строки
контролов), `hideLabel` (та же логика, что у сфер, ADR-189 — блок фильтров без подписей-«шапок»).
`resetCatalogFilters` очищает и `work_type`.

## Отклонено

- **Отдельный справочник/экран видов работ.** Прямой отказ владельца («не надо так... не
  усложняй») — виды работ находятся ТОЛЬКО через уже выбранную сферу, второго уровня поиска
  внутри списка нет.
- **Компонент сам чистит `value` при сужении `spheres` (внутренний эффект).** См. раздел выше —
  ломает независимость `sphere`/`work_type` фильтров поиска (ADR-190 §3), прямая ссылка с одним
  `work_type=` теряла бы параметр при первом рендере.
- **`max` (лимит 30) в поиске.** Лимит — продуктовое решение профиля (ADR-190,
  `PROFILE_MAX_WORK_TYPES`), у фильтра поиска ограничения на количество выбранных значений нет —
  `WorkTypeChipsEditor` вызывается в `SearchPage` без пропа `max`.
- **Композитный код `<сфера>.<категория>` строится на бэке.** `/v1/work-types?sphere=` отдаёт
  голый код категории (`code`) — композитный код (формат `Profile.work_type_codes`/`?work_type=`)
  собирается на фронте (`${sphereCode}.${w.code}`), сфера уже известна из аргумента запроса.

## Тесты

`web/tests/WorkTypeChipsEditor.test.tsx` (новый, 5 тестов) — без сфер не рендерится, раскрытие
списка под сферой + множественный выбор (добавление/снятие), несколько сфер сразу не путают коды
между собой, снятие сферы прячет группу БЕЗ изменения `value` (контракт «чистка — на вызывающей
стороне»), лимит (`max`) блокирует новые чипы, не трогая уже выбранные.

`web/tests/ProfileWorkTypes.test.tsx` (новый, 11 тестов) — раскрытие/множественный выбор в
`ProfileSettingsPage`, сохранение видно при повторном заходе, снятие сферы сразу прячет блок ДО
сохранения, три 422 показывают человекочитаемый текст; отдельно (без подмены `server.use`) —
реальная валидация мок-`patchProfileSettings`: сфера не заявлена/неизвестный код/лимит 30/успешное
сохранение/молчаливая обрезка осиротевших кодов при сужении `sphere_codes` без явного
`work_type_codes` в том же PATCH (зеркало `apps.profiles.services._normalize_work_type_codes`).

`web/tests/SearchCatalogFilters.test.tsx` (+7 тестов, файл целиком 15) — один вид работ в URL находит все подходящие
профили, ИЛИ между несколькими значениями, И с `sphere`, И с гео, разворачивание панели по клику
пишет `work_type=` в URL рядом с `sphere=`, снятие сферы фильтра убирает и `work_type` из URL,
общий сброс фильтров убирает `work_type`.

Мок (`web/src/mocks/`) обновлён как зеркало бэкенда, не заглушка: `profilesDb.ts` —
`PROFILE_MAX_WORK_TYPES`, `normalizeWorkTypeCodes` (та же тройка ошибок и та же тройка правил,
что `apps.profiles.services._normalize_work_type_codes`), `profilesHandlers.ts` — 422 по кодам;
`catalogSearchDb.ts` — `work_types` в сидах + `matchesWorkType`, `groupsHandlers.ts` — повторяемый
параметр `work_type` разбирается и передаётся в фильтр, тоже включает ветку `catalog`.

Прогон: `npx vitest run --pool=threads --poolOptions.threads.minThreads=1
--poolOptions.threads.maxThreads=2` — 23 новых/изменённых теста зелёные (5 + 11 + 7), плюс полный
регресс `SearchScreenDeclutter`/`SearchCatalogEmptyStates`/`SearchGroupsPages`/
`SphereStep.components`/`OwnerProfile.components`/`ProfileAvatar.settings`/`SearchContactsPicker`
(52 теста) без изменений сценариев. `tsc --noEmit` чист.

## Последствия

- `packages/core`: `OwnerProfileSettings.work_type_codes: string[]` — новое поле контракта
  `GET`/`PATCH /profiles/{id}`.
- `features/contractNew/api.ts`: `useWorkTypes` разложен на `workTypesQueryOptions` +
  `useQuery` — тот же `queryKey`, кэш общий с новым компонентом, поведение мастера договора не
  изменилось.
- `features/search/api.ts`: `CatalogSearchFilters.workTypes`, `EMPTY_CATALOG_FILTERS`,
  `catalogFiltersActive`, `probeCatalogNonEmpty`, `useCatalogSearch` — новый параметр `work_type`,
  старое поведение (`country`/`region`/`city`/`sphere`/`experience_min`) не тронуто.
- Локализация: `profile.workType.{label,hint,limit,sphereNotDeclared,invalid}` и
  `dashboard.searchWorkTypeLabel` — ru/en вручную, 27 локалей бэкфиллом (переиспользован уже
  переведённый `contractNew.sphereWorkTypesLabel` для обоих ярлыков-меток, остальное — новый
  перевод по образцу `formSpheresHint`/`formSpheresLimit`/`workArea.limit`). ТЕРМИН в интерфейсе —
  «Типы работ»/«Work types», как уже написано в мастере договора (`contractNew.sphereWorkTypesLabel`)
  и, через бэкфилл, во всех 27 остальных локалях: ru/en сначала были написаны «Виды работ»/«Types of
  work» (разговорная формулировка владельца и планов), из-за чего один и тот же справочник
  назывался в договоре и в профиле по-разному — выровнено в пользу уже переведённого варианта,
  обратное переименование (везде «Виды работ») — правка одного ключа в 29 локалях, если владелец
  предпочтёт свою формулировку. **ПОПРАВКА ВЛАДЕЛЬЦА 13.09: выбран НЕВЕРНЫЙ вариант** — *«вид
  работ. это устойчивое выражение в русском языке. потом исправим»*. Русский термин — «вид работ»;
  правка сделана 16.09 (`feat/web-work-type-term`): в русском интерфейсе везде «Виды работ» /
  «Сфера или вид работ»; английский и остальные локали не меняются. Закрыт локализационный
  пробел ТОЛЬКО для трёх новых кодов ошибок (`profile_work_types_limit`,
  `work_type_sphere_not_declared`, `invalid_work_type`) — соседние коды той же природы
  (`invalid_sphere`, `profile_spheres_limit`, `work_area_limit` и др.) остаются без перевода в
  `l10n/packs/*`/`common/api/error_texts.py`, это ADR-190 отметила как отдельный пробел «для всей
  группы кодов сразу» — фронт не решает его здесь, а только показывает СВОЙ человекочитаемый текст
  по коду ошибки (как уже делает для `work_area_limit`/`work_area_duplicate`), независимо от
  бэкендной локализации `title`.
