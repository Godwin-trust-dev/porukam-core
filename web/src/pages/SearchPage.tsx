import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '@porukam/core';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  FieldHelp,
  Icon,
  SearchResultRow,
  SectionLabel,
  SelectField,
  Skeleton,
  Surface,
  TextField,
  type BadgeTone,
} from '@porukam/ui';
import { catalogFiltersActive, EXPERIENCE_OPTIONS, useCatalogSearch, useSearch, type CatalogSearchFilters } from '../features/search/api';
import { useCatalogEmptySuggestion } from '../features/search/emptyState';
import { GeoFilterSheet } from '../features/search/GeoFilterSheet';
import { geoFilterActive, useGeoFilterLabel, widenGeoFilter, WORLD_GEO_FILTER, type GeoFilter } from '../features/search/geoFilter';
import { catalogWorkAreaLabel } from '../features/search/catalogWorkAreaLabel';
import { SphereChipsEditor } from '../features/profile/SphereChipsEditor';
import { WorkTypeChipsEditor } from '../features/profile/WorkTypeChipsEditor';
import ownStyles from './SearchPage.module.css';
import { apiErrorText } from '../shared/apiErrorText';

/**
 * `/search` (ADR-114; сферы — ADR-121; упрощение раскладки — ADR-189; цвета,
 * раскладка и снятая книга контактов — ADR-192): люди по @хендлу/телефону
 * (поиска по имени нет by design — ФИО зашифровано) и по сфере запроса;
 * объединения по имени/@хендлу и по сфере с их географией. Человек →
 * карточка репутации, объединение → его страница.
 *
 * По сфере человек находится ДВУМЯ путями (бэк, `dashboards.selectors.
 * get_search`): по завершённым сделкам в этой сфере (`sphere_match: 'deals'`)
 * И по заявленной в профиле сфере (`'declared'`, ADR-122) — новичок без
 * единой сделки из выдачи не выпадает. Микрокопия «?» об этом больше НЕ
 * говорит «находим по завершённым сделкам» (замечание владельца 18.09: это
 * была неправда, оставшаяся от ADR-121).
 *
 * Книги контактов на этом экране нет (владелец 18.09: «поиск по контактам из
 * базы порукам бессмысленный»): справочник сохранённых контактов остаётся там,
 * где он решает задачу — на шаге «Стороны» мастера договора (`PartiesStepPage`).
 * Здесь ищут ЧУЖИХ — по @хендлу, телефону или сфере.
 *
 * Результат — общая строка `SearchResultRow` (ADR-152), та же, что в шаге
 * «Стороны» мастера: замечание владельца 03.09 «при поиске контрагента
 * выдаёт рамку, в ней текст „По подтверждению администратора“ наезжает на
 * хендл». Рамки у результата больше нет, хендл стоит второй строкой, статус —
 * словом-цветом в её конце.
 *
 * Гео-ЗОНА этого лукапа (ADR-114 `world|country|city`, относительно СВОЕЙ
 * локации зрителя) и гео-ФИЛЬТР каталога ниже (ADR-184/185, произвольное
 * место где угодно в мире) — разные понятия, второй контрол зоны на экране
 * их не путает (ADR-189, замечание владельца «зона поиска повторяется —
 * убрать»): лукап по хендлу/телефону/сфере теперь ВСЕГДА идёт по всему миру
 * (`zone: 'world'`, см. `useSearch`) — подмешивать сюда выбранное МЕСТО
 * каталожного фильтра было бы нечестно: то место — не «своя страна/город»
 * зрителя, а бэк ждёт от `zone=country|city` именно это.
 *
 * Второй раздел ниже — каталог исполнителей с панелью фильтров (план 11.09
 * §6, ADR-184/185): НЕЗАВИСИМАЯ ветка `catalog` того же `GET /dashboard/
 * search`, адресный лукап по `q` выше не переделан ни строкой. Состояние
 * панели живёт в URL (`country`/`region`/`city`/`sphere`/`experience_min` —
 * ровно имена параметров бэка) — ссылку можно переслать, «назад» браузера
 * возвращает предыдущий набор фильтров.
 *
 * Гео-фильтр (ADR-194, замечания владельца 18.09): каскад `GeoFilterSheet`
 * останавливается на ЛЮБОМ уровне (страна/регион/город — не только «до
 * города»), сортирует страны/регионы/города по алфавиту зрителя, и умеет
 * найти город СРАЗУ, подставив его страну/регион. С заданным гео-фильтром
 * выдача ниже делится на «В выбранном месте» и «Работают удалённо»
 * (`geo_match`, бэк — отдельная параллельная ветка) — пустота выбранного
 * места видна отдельной строкой, а не тонет в общем списке (не увиденная
 * владельцем пустая Армения).
 */

export function SearchPage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const { data, isPending, error, refetch, isFetching } = useSearch(query);

  const [searchParams, setSearchParams] = useSearchParams();
  const [geoSheetOpen, setGeoSheetOpen] = useState(false);

  const active = query.trim().length >= 2;
  // Имя сферы объединения — из распознанных сфер ответа (ADR-121): без лишнего
  // похода в каталог; сфера вне распознанных — просто не подписывается.
  const sphereNames: Record<string, string> = Object.fromEntries((data?.spheres ?? []).map((s) => [s.code, s.name]));

  // --- Каталог исполнителей: панель фильтров + выдача (план 11.09 §6) ------

  function updateParams(patch: Record<string, string | string[] | undefined>): void {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      next.delete(key);
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) next.append(key, item);
      } else {
        next.set(key, value);
      }
    }
    setSearchParams(next);
  }

  const cityParam = searchParams.get('city');
  const parsedCity = cityParam ? Number.parseInt(cityParam, 10) : NaN;
  const geoFilter: GeoFilter = {
    country: searchParams.get('country'),
    region: searchParams.get('region'),
    city: Number.isFinite(parsedCity) ? parsedCity : null,
  };
  const experienceParam = searchParams.get('experience_min');
  const parsedExperience = experienceParam ? Number.parseInt(experienceParam, 10) : NaN;
  const catalogFilters: CatalogSearchFilters = {
    country: geoFilter.country,
    region: geoFilter.region,
    city: geoFilter.city,
    spheres: searchParams.getAll('sphere'),
    // ADR-190/191: виды работ живут в URL так же, как сферы — повторяемый
    // параметр `work_type`, составные коды `<сфера>.<категория>`.
    workTypes: searchParams.getAll('work_type'),
    experienceMin: Number.isFinite(parsedExperience) ? parsedExperience : null,
  };

  function applyGeoFilter(next: GeoFilter): void {
    updateParams({
      country: next.country ?? undefined,
      region: next.region ?? undefined,
      city: next.city != null ? String(next.city) : undefined,
    });
  }

  function resetCatalogFilters(): void {
    updateParams({ country: undefined, region: undefined, city: undefined, sphere: undefined, work_type: undefined, experience_min: undefined });
  }

  const geoLabel = useGeoFilterLabel(geoFilter, i18n.language, t('dashboard.searchGeoWorld'));
  // Гео-фильтр на один уровень ШИРЕ (город → регион → регион → страна →
  // страна → весь мир) — та же функция, что уже применяет пустая выдача
  // каталога целиком (`widen-geo`, ADR-187). Хук зовём БЕЗУСЛОВНО (правило
  // хуков), значение используется только когда «В выбранном месте» пусто
  // (см. ниже, кнопка `search-catalog-local-empty-widen`, решение владельца
  // после ADR-194: «да, добавь кнопку „искать шире“»).
  const widenedGeoFilter = widenGeoFilter(geoFilter);
  const widenedGeoLabel = useGeoFilterLabel(widenedGeoFilter, i18n.language, t('dashboard.searchGeoWorld'));
  const filtersActive = geoFilterActive(geoFilter) || catalogFiltersActive(catalogFilters);
  // Владелец 12.09: «убери выдачу списком всех юзеров... не показывай
  // никого, пока не введён поисковый или фильтрационный запрос» — отменяет
  // прежнее правило ADR-185 «без фильтров на экране — весь мир» (само API
  // без изменений: `catalog=1` без параметров по-прежнему вернёт весь мир,
  // если его позвать явно, см. `useCatalogSearch`). На экране каталог теперь
  // не запрашивается вовсе, пока не задан хотя бы один фильтр (гео/сфера/
  // опыт) — `enabled` ниже, не «показать скелетон/пусто», а НЕ ПОЗВАТЬ.
  const catalogQuery = useCatalogSearch(catalogFilters, filtersActive);
  const catalogItems = (catalogQuery.data?.pages ?? []).flatMap((page) => page.items);
  // Разбор пустой выдачи на конкретный совет (план 11.09 §7, ADR-187) — см.
  // `useCatalogEmptySuggestion`. Считается только когда список пуст, фильтр
  // задан (иначе запрос не улетал вовсе — см. выше) и основной запрос уже
  // отработал (не на скелетоне/ошибке).
  const catalogEmpty = filtersActive && !catalogQuery.isPending && !catalogQuery.error && catalogItems.length === 0;
  const emptySuggestion = useCatalogEmptySuggestion(catalogFilters, geoFilter, catalogEmpty, i18n.language, t('dashboard.searchGeoWorld'));

  // ADR-194 (владелец 18.09, «десктоп_поиск.png» — Армения без единого
  // местного не была видна на общем списке): с заданным гео-фильтром выдачу
  // делим на «В выбранном месте» (`geo_match: 'local'`) и «Работают удалённо»
  // (остальное) — БЕЗ фильтра список остаётся один, как раньше. Критерий
  // деления — САМ гео-фильтр (`geoFilterActive`), а не наличие `geo_match` у
  // элементов: поле необязательное (бэк — отдельная параллельная ветка). В
  // «удалённые» попадает и `'remote'`, и `undefined`/`null` (ДО мержа бэкенда
  // или если бэк вернул неполные данные) — строго НАОБОРОТ терять строку
  // молча было бы хуже: местного не покажем «местным» без явного подтверждения,
  // а из выдачи он всё равно не пропадёт.
  const showGeoSplit = geoFilterActive(geoFilter);
  const localCatalogItems = catalogItems.filter((item) => item.geo_match === 'local');
  const remoteCatalogItems = catalogItems.filter((item) => item.geo_match !== 'local');

  function renderCatalogRow(item: (typeof catalogItems)[number]): JSX.Element {
    const primaryArea = item.work_areas.find((wa) => wa.scope !== 'world') ?? item.work_areas[0];
    return (
      <SearchResultRow
        key={item.profile_id}
        name={item.display_name ?? item.handle ?? t('dashboard.sectionCounterpartyFallback')}
        handle={item.handle}
        avatarSrc={item.avatar_url ?? undefined}
        meta={
          <>
            <span>{catalogWorkAreaLabel(primaryArea, i18n.language, t('dashboard.searchGeoWorld'))}</span>
            {' · '}
            <span>{t('dashboard.searchExperienceCount', { count: item.completed_deals_count })}</span>
          </>
        }
        onOpen={() => navigate(item.handle ? `/${item.handle}` : `/reputation/profiles/${item.profile_id}`)}
      />
    );
  }

  return (
    <div className={ownStyles.wrap}>
      <TextField
        aria-label={t('nav.search')}
        placeholder={t('dashboard.searchPlaceholder')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        // Заголовок экрана («Поиск», `ShellLayout`) уже называет поле — вторая
        // видимая подпись была бы дублем; смысл «поиска по имени нет» (ADR-114)
        // ушёл в «?» (ADR-189: «прячь все комментарии», не абзацем на экране).
        help={t('dashboard.searchHint')}
        helpLabel={t('hints.helpButton')}
        data-testid="search-input"
      />
      {active && data && (data.spheres?.length ?? 0) > 0 ? (
        <div className={ownStyles.spheres} data-testid="search-spheres">
          <span>{t('dashboard.searchSpheresFound')}</span>
          {data.spheres?.map((s) => (
            <Badge key={s.code} tone="ink">
              {s.name}
            </Badge>
          ))}
        </div>
      ) : null}

      {!active ? null : isPending || isFetching ? (
        <div className={ownStyles.loading} aria-busy="true">
          <Skeleton height={54} radius="var(--pr-d-r-surface)" />
          <Skeleton height={54} radius="var(--pr-d-r-surface)" />
        </div>
      ) : error ? (
        <ErrorState
          title={t('common.unexpectedErrorTitle')}
          text={apiErrorText(error)}
          code={error instanceof ApiError ? error.code : undefined}
          retryLabel={t('common.retry')}
          onRetry={() => void refetch()}
        />
      ) : data && data.profiles.length === 0 && data.groups.length === 0 ? (
        <EmptyState icon="search" title={t('dashboard.searchEmptyTitle')} text={t('dashboard.searchEmptyText')} />
      ) : data ? (
        <>
          {data.profiles.length > 0 ? (
            <section className={ownStyles.section}>
              <SectionLabel level={3}>{t('dashboard.searchPeopleTitle')}</SectionLabel>
              <Surface bleed data-testid="search-people">
                {data.profiles.map((p) => {
                  /* Пометок у человека может быть две сразу (номер не
                     подтверждён + совпадение по сфере). Первая идёт статусом
                     словом в конце второй строки, остальные — третьей: в
                     одну строку они наезжали на хендл. */
                  const marks: { label: string; tone: BadgeTone }[] = [];
                  if (p.phone_unverified) marks.push({ label: t('dashboard.searchPhoneUnverified'), tone: 'amber' });
                  if (p.sphere_match === 'deals') marks.push({ label: t('dashboard.searchSphereMatch'), tone: 'green' });
                  else if (p.sphere_match === 'declared')
                    marks.push({ label: t('dashboard.searchSphereDeclared'), tone: 'neutral' });
                  const [primary, ...rest] = marks;
                  return (
                    <SearchResultRow
                      key={p.profile_id}
                      name={p.display_name ?? p.handle ?? t('dashboard.sectionCounterpartyFallback')}
                      handle={p.handle}
                      meta={p.city_name ? <span>{p.city_name}</span> : null}
                      statusLabel={primary?.label}
                      statusTone={primary?.tone}
                      extra={rest.length > 0 ? <span>{rest.map((m) => m.label).join(' · ')}</span> : undefined}
                      onOpen={() => navigate(p.handle ? `/${p.handle}` : `/reputation/profiles/${p.profile_id}`)}
                    />
                  );
                })}
              </Surface>
            </section>
          ) : null}
          {data.groups.length > 0 ? (
            <section className={ownStyles.section}>
              <SectionLabel level={3}>{t('dashboard.searchGroupsTitle')}</SectionLabel>
              <Surface bleed data-testid="search-groups">
                {data.groups.map((g) => (
                  <SearchResultRow
                    key={g.id}
                    name={g.name}
                    handle={g.handle}
                    meta={
                      <>
                        <span>{t('dashboard.groupMembersCount', { count: g.members_count })}</span>
                        {g.sphere_code && sphereNames[g.sphere_code] ? (
                          <>
                            {' · '}
                            <span>{sphereNames[g.sphere_code]}</span>
                          </>
                        ) : null}
                      </>
                    }
                    statusLabel={t(g.join_policy === 'open' ? 'dashboard.groupPolicyOpen' : 'dashboard.groupPolicyApproval')}
                    statusTone={g.join_policy === 'open' ? 'green' : 'neutral'}
                    statusOwnLine
                    onOpen={() => navigate(`/groups/${g.id}`)}
                  />
                ))}
              </Surface>
            </section>
          ) : null}
        </>
      ) : null}

      {/* Каталог исполнителей (план 11.09 §6, ADR-184/185; стартовое состояние
          — ADR-189, владелец 12.09): панель фильтров сужает выдачу, но САМ
          список теперь появляется только когда задан хотя бы один фильтр —
          прежнее «без единого фильтра уже весь мир» (владелец 11.09) этим же
          владельцем 12.09 отменено («не показывай никого, пока не введён...
          запрос»). */}
      <section className={ownStyles.section}>
        <SectionLabel
          level={2}
          // Смысл убранного абзаца («гео/сфера/опыт можно сочетать по
          // отдельности») никуда не делся — он за «?» (ADR-189), не строкой
          // под заголовком: тот же приём, что подсказка поля поиска выше.
          aside={<FieldHelp label={t('hints.helpButton')}>{t('dashboard.searchCatalogHint')}</FieldHelp>}
        >
          {t('dashboard.searchCatalogTitle')}
        </SectionLabel>

        <div className={ownStyles.catalogFilters}>
          {/* Фильтры — не действия экрана: белые контролы с рамкой, один
              в один как поле запроса выше (ADR-192). Тёмная `secondary`
              делала из строки фильтров три чёрные плашки на креме. */}
          <Button
            variant="outline"
            className={ownStyles.filterButton}
            onClick={() => setGeoSheetOpen(true)}
            data-testid="search-geo-filter-open"
          >
            <Icon name="globe" size={16} />
            {geoLabel}
          </Button>
          <SelectField
            aria-label={t('dashboard.searchExperienceLabel')}
            value={catalogFilters.experienceMin != null ? String(catalogFilters.experienceMin) : ''}
            onChange={(e) => updateParams({ experience_min: e.target.value || undefined })}
            data-testid="search-experience-filter"
          >
            <option value="">{t('dashboard.searchExperienceAny')}</option>
            {EXPERIENCE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {t('dashboard.searchExperienceMinOption', { count: n })}
              </option>
            ))}
          </SelectField>
          {filtersActive ? (
            <Button variant="ghost" size="sm" onClick={resetCatalogFilters} data-testid="search-catalog-reset">
              {t('dashboard.searchCatalogResetFilters')}
            </Button>
          ) : null}
        </div>

        {/* Сферы — не контрол строки фильтров, а разворачивающийся блок
            (ADR-192): открытый пикер занимает половину экрана, и соседняя
            гео-кнопка висела посреди него по вертикали. Своя строка под
            строкой контролов, ровно над видами работ, которые и так живут
            отдельной строкой ниже. */}
        <SphereChipsEditor
          value={catalogFilters.spheres}
          onChange={(codes) => {
            // ADR-190/191: снятие сферы фильтра сразу снимает и её виды
            // работ из URL (тот же приём, что в профиле, ProfileSettingsPage)
            // — ОДНИМ вызовом `updateParams`, не двумя подряд: второй вызов
            // строил бы `next` от того же «старого» `searchParams` (замыкание),
            // потеряв изменение сфер первого вызова.
            const keptWorkTypes = catalogFilters.workTypes.filter((c) => codes.includes(c.split('.')[0] ?? ''));
            updateParams({
              sphere: codes.length > 0 ? codes : undefined,
              work_type: keptWorkTypes.length > 0 ? keptWorkTypes : undefined,
            });
          }}
          label={t('dashboard.searchSphereLabel')}
          testId="search-sphere-filter"
          // Внешний заголовок блока («Сферы») убран — он дублировал подпись
          // поля поиска пикера («Сфера или вид работ», ADR-189). Та подпись
          // — единственная, что остаётся у сфер, и только пока пикер открыт;
          // aria-label ниже сохраняет доступное имя блока для скринридера.
          hideLabel
          collapsedByDefault
          addVariant="outline"
        />

        {/* ADR-190/191: виды работ разворачиваются ПОД выбранными сферами
            фильтра — своя строка ниже `.catalogFilters`, а не внутри той же
            строки (списки видов работ у нескольких сфер сразу шире, чем одна
            строка контролов). Без выбранной сферы — рендерить нечего,
            компонент сам вернёт `null`. */}
        <WorkTypeChipsEditor
          spheres={catalogFilters.spheres}
          value={catalogFilters.workTypes}
          onChange={(codes) => updateParams({ work_type: codes.length > 0 ? codes : undefined })}
          label={t('dashboard.searchWorkTypeLabel')}
          testId="search-work-type-filter"
          hideLabel
        />

        <GeoFilterSheet open={geoSheetOpen} onClose={() => setGeoSheetOpen(false)} onApply={applyGeoFilter} />

        {!filtersActive ? (
          // Владелец 12.09: «не показывай никого, пока не введён поисковый
          // или фильтрационный запрос» — стартовое состояние вместо списка
          // ВСЕХ пользователей каталога (ADR-189/ADR-185 отменена в этой
          // части). Ни один запрос на сервер при этом не улетает — см.
          // `enabled` у `useCatalogSearch` выше, а не просто скрытый список.
          // Кнопки-действия у состояния больше нет (ADR-192): она вела в книгу
          // контактов, которой на этом экране не осталось. Длинная строка
          // разрезана на заголовок и подсказку — крупным кеглем висело всё
          // предложение целиком, на телефоне в три строки.
          <EmptyState
            icon="search"
            title={t('dashboard.searchCatalogStartTitle')}
            text={t('dashboard.searchCatalogStartText')}
          />
        ) : catalogQuery.isPending ? (
          <div className={ownStyles.loading} aria-busy="true">
            <Skeleton height={54} radius="var(--pr-d-r-surface)" />
            <Skeleton height={54} radius="var(--pr-d-r-surface)" />
          </div>
        ) : catalogQuery.error ? (
          <ErrorState
            title={t('common.unexpectedErrorTitle')}
            text={apiErrorText(catalogQuery.error)}
            code={catalogQuery.error instanceof ApiError ? catalogQuery.error.code : undefined}
            retryLabel={t('common.retry')}
            onRetry={() => void catalogQuery.refetch()}
          />
        ) : catalogItems.length === 0 ? (
          emptySuggestion.kind === 'checking' ? (
            <div className={ownStyles.loading} aria-busy="true">
              <Skeleton height={54} radius="var(--pr-d-r-surface)" />
              <Skeleton height={54} radius="var(--pr-d-r-surface)" />
            </div>
          ) : emptySuggestion.kind === 'no-data' ? (
            // Фильтров нет вовсе — расширять нечего, каталог пока пуст сам по себе.
            <EmptyState icon="search" title={t('dashboard.searchCatalogEmptyNoDataTitle')} text={t('dashboard.searchCatalogEmptyNoDataText')} />
          ) : emptySuggestion.kind === 'widen-geo' ? (
            // Гео сузило до нуля — уровень шире уже находит кого-то, одна кнопка.
            <EmptyState
              icon="search"
              title={t('dashboard.searchCatalogEmptyGeoTitle')}
              text={t('dashboard.searchCatalogEmptyGeoText')}
              actionLabel={t('dashboard.searchCatalogEmptyGeoAction', { name: emptySuggestion.label })}
              onAction={() => applyGeoFilter(emptySuggestion.next)}
            />
          ) : emptySuggestion.kind === 'remove-sphere' ? (
            // Сфера сузила до нуля именно в этом месте — гео не помогает, помогает сфера.
            <EmptyState
              icon="search"
              title={t('dashboard.searchCatalogEmptySphereTitle')}
              text={t('dashboard.searchCatalogEmptySphereText')}
              actionLabel={t('dashboard.searchCatalogEmptyRemoveSphereAction')}
              onAction={() => updateParams({ sphere: undefined })}
            />
          ) : emptySuggestion.kind === 'remove-geo' ? (
            // Сфера сузила до нуля именно в этом месте — сфера не помогает, помогает гео.
            <EmptyState
              icon="search"
              title={t('dashboard.searchCatalogEmptySphereTitle')}
              text={t('dashboard.searchCatalogEmptySphereText')}
              actionLabel={t('dashboard.searchCatalogEmptyRemoveGeoAction')}
              onAction={() => applyGeoFilter(WORLD_GEO_FILTER)}
            />
          ) : emptySuggestion.kind === 'sphere-or-geo' ? (
            // Помогает и то, и другое по отдельности — два понятных действия.
            <EmptyState
              icon="search"
              title={t('dashboard.searchCatalogEmptySphereTitle')}
              text={t('dashboard.searchCatalogEmptySphereText')}
              actionLabel={t('dashboard.searchCatalogEmptyRemoveSphereAction')}
              onAction={() => updateParams({ sphere: undefined })}
              secondaryActionLabel={t('dashboard.searchCatalogEmptyRemoveGeoAction')}
              onSecondaryAction={() => applyGeoFilter(WORLD_GEO_FILTER)}
            />
          ) : emptySuggestion.kind === 'lower-experience' ? (
            // Порог опыта отсекает всех — предлагаем ближайший меньший пресет.
            <EmptyState
              icon="search"
              title={t('dashboard.searchCatalogEmptyExperienceTitle')}
              text={t('dashboard.searchCatalogEmptyExperienceText')}
              actionLabel={t('dashboard.searchCatalogEmptyExperienceAction', {
                value:
                  emptySuggestion.next != null
                    ? t('dashboard.searchExperienceMinOption', { count: emptySuggestion.next })
                    : t('dashboard.searchExperienceAny'),
              })}
              onAction={() => updateParams({ experience_min: emptySuggestion.next != null ? String(emptySuggestion.next) : undefined })}
            />
          ) : (
            // reset-all: ни одно точечное ослабление не помогло — прежнее общее поведение.
            <EmptyState
              icon="search"
              title={t('dashboard.searchCatalogEmptyTitle')}
              text={t('dashboard.searchCatalogEmptyText')}
              actionLabel={filtersActive ? t('dashboard.searchCatalogResetFilters') : undefined}
              onAction={filtersActive ? resetCatalogFilters : undefined}
            />
          )
        ) : (
          <>
            {showGeoSplit ? (
              // ADR-194: два подзаголовка вместо одного списка — внешний
              // `data-testid="search-catalog-list"` держим ОБЩИМ (не меняем
              // контракт существующих тестов, которые ищут строки внутри
              // него независимо от деления), деление — вложенными testid'ами.
              <div data-testid="search-catalog-list">
                <SectionLabel level={3}>{t('dashboard.searchCatalogLocalTitle')}</SectionLabel>
                {localCatalogItems.length > 0 ? (
                  <Surface bleed data-testid="search-catalog-list-local">
                    {localCatalogItems.map(renderCatalogRow)}
                  </Surface>
                ) : (
                  <div className={ownStyles.catalogLocalEmpty} data-testid="search-catalog-list-local-empty">
                    <p className={ownStyles.catalogLocalEmptyText}>{t('dashboard.searchCatalogLocalEmpty')}</p>
                    {/* Владелец, после ADR-194: «да, добавь кнопку „искать
                        шире“» — та же механика, что уже применяет пустая
                        выдача каталога целиком (`widen-geo`, ADR-187), без
                        проб-запроса: этот блок пуст не «вообще», а только по
                        местным, расширение предлагается безусловно. */}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => applyGeoFilter(widenedGeoFilter)}
                      data-testid="search-catalog-local-empty-widen"
                    >
                      {t('dashboard.searchCatalogEmptyGeoAction', { name: widenedGeoLabel })}
                    </Button>
                  </div>
                )}
                {remoteCatalogItems.length > 0 ? (
                  <>
                    <SectionLabel level={3}>{t('dashboard.searchCatalogRemoteTitle')}</SectionLabel>
                    <Surface bleed data-testid="search-catalog-list-remote">
                      {remoteCatalogItems.map(renderCatalogRow)}
                    </Surface>
                  </>
                ) : null}
              </div>
            ) : (
              <Surface bleed data-testid="search-catalog-list">
                {catalogItems.map(renderCatalogRow)}
              </Surface>
            )}
            {catalogQuery.hasNextPage ? (
              <div className={ownStyles.showMore}>
                <Button
                  variant="secondary"
                  block
                  loading={catalogQuery.isFetchingNextPage}
                  onClick={() => void catalogQuery.fetchNextPage()}
                  data-testid="search-catalog-show-more"
                >
                  {t('dashboard.searchCatalogShowMore')}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
