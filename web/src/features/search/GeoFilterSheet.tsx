import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Sheet, TextField } from '@porukam/ui';
import type { GeoCity, GeoCountry, GeoRegion } from '@porukam/core';
import { useGeoCities, useGeoCountries, useGeoRegions, filterCountries } from '../geo/api';
import { useDebounced } from '../../shared/useDebounced';
import { countryName } from '../groups/groupLabels';
import type { GeoFilter } from './geoFilter';
// Список/строка/«назад» — тот же визуальный язык, что каскад региона работы
// профиля (`WorkAreaPickerSheet`, ADR-182): переиспользуем его CSS-модуль,
// а не заводим третью копию идентичных классов.
import styles from '../profile/WorkAreaPickerSheet.module.css';

type Step = 'country' | 'region' | 'city';

export interface GeoFilterSheetProps {
  open: boolean;
  onClose: () => void;
  /** Заменяет фильтр целиком и закрывает шит. `WORLD_GEO_FILTER` — пункт
   * «Весь мир» (владелец 11.09: «и вообще без этого фильтра»). */
  onApply: (next: GeoFilter) => void;
}

/** Строка города в ГЛОБАЛЬНОМ поле поиска (шаг «Страна», ADR-194) —
 * показывает, что подставится при выборе: «‹город› · ‹регион›, ‹страна›»,
 * без региона (в источнике не у каждого города он известен) — «‹город›,
 * ‹страна›» (владелец 18.09: «еще можно сделать что вводит город а ему
 * сразу подставляют регион»). */
function globalCityLabel(city: GeoCity, lang: string): string {
  const country = countryName(city.country, lang);
  if (city.region_name) return `${city.display_name} · ${city.region_name}, ${country}`;
  return country ? `${city.display_name}, ${country}` : city.display_name;
}

/**
 * Каскадный выбор гео-ФИЛЬТРА каталога (план 11.09 §6, ADR-184/185/194):
 * страна → регион → город, на существующих эндпоинтах `apps.geo`
 * (`features/geo/api.ts` — те же хуки, что уже использует
 * `WorkAreaPickerSheet`, ЧУЖОЙ UI-компонент здесь не переиспользуется:
 * тот привязан к «добавить одно из до пяти мест в список», а фильтр —
 * это ОДНО значение, которое либо заменяют целиком, либо снимают).
 *
 * Остановиться на ЛЮБОМ уровне (ADR-194, владелец 18.09: «невозможно
 * остановить поиск на стране например или регионе... так не должно быть»)
 * — липкая главная кнопка шита (`Sheet.actions`, тот же приём, что «Выбрать»
 * у `FilterSheet`): «Показать: ‹текущее место›» применяет фильтр ТЕКУЩЕГО
 * шага (страна на шаге «Регион», регион/страна на шаге «Город») и закрывает
 * шит. На шаге «Страна» кнопки нет — место ещё не выбрано, там своя строка
 * «Весь мир». Прежние строки «Вся страна: X» / «Только X, без города» в
 * потоке шагов убраны — дублировали липкую кнопку тем же действием.
 *
 * Переход «к городам всей страны, минуя регион» (шаг «Регион», кнопка
 * `geo-filter-region-skip`) ОСТАЁТСЯ — это НАВИГАЦИЯ (открывает шаг «Город»
 * без выбранного региона), не применение фильтра, и убирать её задним
 * числом было ошибкой (регрессия, исправлена той же сессией): человек,
 * который выбрал страну и хочет конкретный город, не обязан сперва знать
 * область. Убрана была ТОЛЬКО прежняя ФОРМУЛИРОВКА («Не сужать — искать по
 * всей стране») — она обещала применить фильтр, хотя лишь переключала шаг
 * (жалоба владельца 18.09); текст кнопки честный (`searchGeoRegionSkipToCities`
 * — «Не знаю регион — показать города страны»), а её место в макете — под
 * полем поиска региона, стилем `styles.skip` (второстепенное действие), а
 * не в `Sheet.actions` (это не применение фильтра).
 *
 * На шаге «Страна» есть ВТОРОЕ поле — глобальный поиск города без страны
 * (владелец 18.09: «вводит город а ему сразу подставляют регион, так
 * быстрее»): выбор сразу применяет фильтр целиком (`{ country, region,
 * city }` из найденного города), страна и регион подставляются сами.
 *
 * Шит ВСЕГДА открывается заново с шага «страна» (как форма замены значения,
 * а не редактор текущего) — действующий фильтр виден рядом, в кнопке-
 * триггере панели (`useGeoFilterLabel`).
 */
export function GeoFilterSheet({ open, onClose, onApply }: GeoFilterSheetProps): JSX.Element | null {
  const { t, i18n } = useTranslation();
  const [history, setHistory] = useState<Step[]>(['country']);
  const step = history[history.length - 1] ?? 'country';
  const [country, setCountry] = useState<GeoCountry | null>(null);
  const [region, setRegion] = useState<GeoRegion | null>(null);
  const [countryQuery, setCountryQuery] = useState('');
  const [regionQuery, setRegionQuery] = useState('');
  const [cityQuery, setCityQuery] = useState('');
  const [globalCityQuery, setGlobalCityQuery] = useState('');

  const debouncedRegionQuery = useDebounced(regionQuery, 250);
  const debouncedCityQuery = useDebounced(cityQuery, 250);
  const debouncedGlobalCityQuery = useDebounced(globalCityQuery, 250);
  const { data: countries } = useGeoCountries();
  const { data: regions } = useGeoRegions(country?.code, debouncedRegionQuery);
  const { data: cities, isFetching: citiesFetching } = useGeoCities(country?.code, region?.code, debouncedCityQuery);
  // Глобальный поиск города — БЕЗ страны/региона; хук сам включает запрос
  // только на непустой `q` (`useGeoCities`, `features/geo/api.ts`), иначе
  // на каждое открытие шита улетал бы запрос «весь мир без строки».
  const { data: globalCities } = useGeoCities(undefined, undefined, debouncedGlobalCityQuery);

  function reset(): void {
    setHistory(['country']);
    setCountry(null);
    setRegion(null);
    setCountryQuery('');
    setRegionQuery('');
    setCityQuery('');
    setGlobalCityQuery('');
  }

  function handleClose(): void {
    reset();
    onClose();
  }

  function apply(next: GeoFilter): void {
    onApply(next);
    handleClose();
  }

  function push(next: Step): void {
    setHistory((h) => [...h, next]);
  }

  function goBack(): void {
    setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h));
  }

  function pickCountry(picked: GeoCountry): void {
    setCountry(picked);
    setCountryQuery('');
    // Смена страны обнуляет регион/город и их поисковые строки — иначе,
    // вернувшись с шага «регион» назад и выбрав ДРУГУЮ страну, список нового
    // региона показался бы отфильтрован остатком текста от прошлой страны
    // (`region`/`regionQuery`/`cityQuery` иначе переживают `goBack`).
    setRegion(null);
    setRegionQuery('');
    setCityQuery('');
    push('region');
  }

  function pickRegion(picked: GeoRegion): void {
    setRegion(picked);
    setRegionQuery('');
    push('city');
  }

  /** Переход к городам ВСЕЙ страны, минуя регион (ADR-194 — навигация, не
   * применение фильтра: тот же переход, что раньше делала кнопка «Не сужать
   * — искать по всей стране», только с честной подписью, см. коммент
   * компонента выше). НЕ вызывает `apply` — просто открывает шаг «Город» с
   * `region: null`, дальше человек либо выбирает город, либо жмёт липкую
   * кнопку «Показать: ‹страна›» уже там. */
  function skipRegion(): void {
    setRegion(null);
    push('city');
  }

  function pickCity(picked: GeoCity): void {
    apply({ country: picked.country, region: picked.region, city: picked.id });
  }

  /** Липкая кнопка шита — применяет фильтр ТЕКУЩЕГО уровня (см. коммент
   * компонента выше) и закрывает шит. */
  function applyCurrentLevel(): void {
    if (!country) return;
    if (step === 'region') {
      apply({ country: country.code, region: null, city: null });
    } else if (step === 'city') {
      apply({ country: country.code, region: region?.code ?? null, city: null });
    }
  }

  if (!open) return null;

  const titles: Record<Step, string> = {
    country: t('dashboard.searchGeoCountryStepTitle'),
    region: t('dashboard.searchGeoRegionStepTitle'),
    city: t('dashboard.searchGeoCityStepTitle'),
  };

  const cityEmpty = !citiesFetching && debouncedCityQuery.trim().length > 0 && (cities ?? []).length === 0;

  const currentLevelName =
    step === 'city' && region ? region.display_name : country ? countryName(country.code, i18n.language) : '';
  const showApplyButton = (step === 'region' || step === 'city') && country != null;

  return (
    <Sheet
      open={open}
      title={titles[step]}
      onClose={handleClose}
      closeLabel={t('common.close')}
      actions={
        showApplyButton ? (
          <Button variant="primary" block onClick={applyCurrentLevel} data-testid="geo-filter-apply-current">
            {t('dashboard.searchGeoApplyCurrent', { name: currentLevelName })}
          </Button>
        ) : undefined
      }
    >
      {step !== 'country' ? (
        <button type="button" className={styles.back} onClick={goBack} data-testid="geo-filter-back">
          {t('dashboard.searchGeoBack')}
        </button>
      ) : null}

      {step === 'country' ? (
        <>
          <ul className={styles.list} data-testid="geo-filter-top-list">
            <li>
              <button type="button" className={styles.row} onClick={() => apply({ country: null, region: null, city: null })} data-testid="geo-filter-world">
                {t('dashboard.searchGeoWorld')}
              </button>
            </li>
          </ul>
          <TextField
            type="search"
            label={t('dashboard.searchGeoCountrySearchLabel')}
            placeholder={t('dashboard.searchGeoCountrySearchPlaceholder')}
            value={countryQuery}
            onChange={(e) => setCountryQuery(e.target.value)}
            data-testid="geo-filter-country-search"
          />
          <ul className={styles.list} data-testid="geo-filter-country-list">
            {filterCountries(countries ?? [], countryQuery, (code) => countryName(code, i18n.language)).map((c) => (
              <li key={c.code}>
                <button type="button" className={styles.row} onClick={() => pickCountry(c)} data-testid={`geo-filter-country-${c.code}`}>
                  {countryName(c.code, i18n.language)}
                </button>
              </li>
            ))}
          </ul>
          {/* ADR-194 (владелец 18.09, п.3) — «ввёл город, а ему сразу
              подставляют регион»: глобальный поиск города, страну выбирать
              не нужно, она подставится из найденного города. */}
          <TextField
            type="search"
            label={t('dashboard.searchGeoGlobalCityLabel')}
            placeholder={t('dashboard.searchGeoGlobalCitySearchPlaceholder')}
            value={globalCityQuery}
            onChange={(e) => setGlobalCityQuery(e.target.value)}
            data-testid="geo-filter-global-city-search"
          />
          {(globalCities ?? []).length > 0 ? (
            <ul className={styles.list} data-testid="geo-filter-global-city-list">
              {(globalCities ?? []).map((c) => (
                <li key={c.id}>
                  <button type="button" className={styles.row} onClick={() => pickCity(c)} data-testid={`geo-filter-global-city-${c.id}`}>
                    {globalCityLabel(c, i18n.language)}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      {step === 'region' && country ? (
        <>
          <TextField
            type="search"
            label={t('dashboard.searchGeoRegionSearchLabel')}
            placeholder={t('dashboard.searchGeoRegionSearchPlaceholder')}
            value={regionQuery}
            onChange={(e) => setRegionQuery(e.target.value)}
            data-testid="geo-filter-region-search"
          />
          {/* Навигация «к городам всей страны, минуя регион» — НЕ применяет
              фильтр (это делает липкая кнопка `Sheet.actions` выше/ниже),
              просто открывает шаг «Город» без выбранного региона. Прежняя
              формулировка («Не сужать — искать по всей стране») обещала
              применить фильтр, хотя только переключала шаг — жалоба
              владельца 18.09; сама навигация нужна («человек, который
              выбрал Казахстан и хочет Алматы, обязан сперва знать область»
              — без нужды), формулировка честная. */}
          <button type="button" className={styles.skip} onClick={skipRegion} data-testid="geo-filter-region-skip">
            {t('dashboard.searchGeoRegionSkipToCities')}
          </button>
          <ul className={styles.list} data-testid="geo-filter-region-list">
            {(regions ?? []).map((r) => (
              <li key={r.code}>
                <button type="button" className={styles.row} onClick={() => pickRegion(r)} data-testid={`geo-filter-region-${r.code}`}>
                  {r.display_name}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {step === 'city' && country ? (
        <>
          <TextField
            type="search"
            label={t('dashboard.searchGeoCitySearchLabel')}
            placeholder={t('dashboard.searchGeoCitySearchPlaceholder')}
            value={cityQuery}
            onChange={(e) => setCityQuery(e.target.value)}
            data-testid="geo-filter-city-search"
          />
          {(cities ?? []).length > 0 ? (
            <>
              <ul className={styles.list} data-testid="geo-filter-city-list">
                {(cities ?? []).map((c) => (
                  <li key={c.id}>
                    <button type="button" className={styles.row} onClick={() => pickCity(c)} data-testid={`geo-filter-city-${c.id}`}>
                      {c.display_name}
                    </button>
                  </li>
                ))}
              </ul>
              {/* Владелец 18.09: города — «алфавит среди 50 крупнейших»
                  (`useGeoCities`, лимит бэка), не «пролистать все города» —
                  подсказка, что список не полный. */}
              <p className={styles.emptyText} data-testid="geo-filter-city-limit-hint">
                {t('dashboard.searchGeoCityLimitHint')}
              </p>
            </>
          ) : null}
          {cityEmpty ? (
            <div className={styles.empty} data-testid="geo-filter-city-empty">
              <p className={styles.emptyText}>{t('dashboard.searchGeoCityEmptyHint')}</p>
              <div className={styles.emptyActions}>
                {region ? (
                  <button
                    type="button"
                    className={styles.row}
                    onClick={() => apply({ country: country.code, region: region.code, city: null })}
                    data-testid="geo-filter-city-empty-region"
                  >
                    {t('dashboard.searchGeoWholeRegion', { name: region.display_name })}
                  </button>
                ) : null}
                <button
                  type="button"
                  className={styles.row}
                  onClick={() => apply({ country: country.code, region: null, city: null })}
                  data-testid="geo-filter-city-empty-country"
                >
                  {t('dashboard.searchGeoWholeCountry', { name: countryName(country.code, i18n.language) })}
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </Sheet>
  );
}
