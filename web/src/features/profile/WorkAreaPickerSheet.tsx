import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sheet, TextField } from '@porukam/ui';
import type { GeoCity, GeoCountry, GeoRegion, WorkArea, WorkAreaScope } from '@porukam/core';
import { useGeoCities, useGeoCountries, useGeoRegions, filterCountries } from '../geo/api';
import { useDebounced } from '../../shared/useDebounced';
import { countryName } from '../groups/groupLabels';
import styles from './WorkAreaPickerSheet.module.css';

type Step = 'scope' | 'country' | 'region' | 'city';

export interface WorkAreaPickerSheetProps {
  open: boolean;
  onClose: () => void;
  /** Возвращает текст ошибки (дубль/лимит), если добавить нельзя — тогда
   * шит НЕ закрывается, ошибка показывается прямо в нём (владелец 11.09:
   * «при попытке добавить шестую — понятная подсказка, а не ошибка
   * сервера»). `null` — добавление приняли, шит закрывается сам. */
  onPick: (scope: WorkAreaScope, location: WorkArea['location']) => string | null;
}

/**
 * Каскадный выбор региона работы (план 11.09 §4, ADR-182): масштаб → страна
 * → регион → город, поиск по мере набора — те же приёмы, что `SpherePicker`
 * (`useSpheres`/`useDebounced`) и `ContactPickerSheet` (`Sheet`: снизу на
 * телефоне, модалкой на десктопе). Шаги идут вперёд по стеку `history` —
 * «Назад» просто снимает верхний шаг, а не пересчитывает его с нуля.
 *
 * Малые населённые пункты (владелец: «не попадают жители маленьких
 * городов», справочник — от 15 000 жителей, ADR-179): если поиск города
 * ничего не даёт, шаг «Город» сам предлагает уйти на регион/страну — ТУТ ЖЕ,
 * без выхода из окна (план 11.09 §4 п.5).
 */
export function WorkAreaPickerSheet({ open, onClose, onPick }: WorkAreaPickerSheetProps): JSX.Element | null {
  const { t, i18n } = useTranslation();
  const [history, setHistory] = useState<Step[]>(['scope']);
  const step = history[history.length - 1] ?? 'scope';
  const [scope, setScope] = useState<WorkAreaScope | null>(null);
  const [country, setCountry] = useState<GeoCountry | null>(null);
  const [region, setRegion] = useState<GeoRegion | null>(null);
  const [countryQuery, setCountryQuery] = useState('');
  const [regionQuery, setRegionQuery] = useState('');
  const [cityQuery, setCityQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const debouncedRegionQuery = useDebounced(regionQuery, 250);
  const debouncedCityQuery = useDebounced(cityQuery, 250);
  const { data: countries } = useGeoCountries();
  const { data: regions } = useGeoRegions(country?.code, debouncedRegionQuery);
  const { data: cities, isFetching: citiesFetching } = useGeoCities(country?.code, region?.code, debouncedCityQuery);

  function reset(): void {
    setHistory(['scope']);
    setScope(null);
    setCountry(null);
    setRegion(null);
    setCountryQuery('');
    setRegionQuery('');
    setCityQuery('');
    setError(null);
  }

  function handleClose(): void {
    reset();
    onClose();
  }

  function push(next: Step): void {
    setError(null);
    setHistory((h) => [...h, next]);
  }

  function goBack(): void {
    setError(null);
    setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h));
  }

  function finalize(finalScope: WorkAreaScope, location: WorkArea['location']): void {
    const err = onPick(finalScope, location);
    if (err) {
      setError(err);
      return;
    }
    handleClose();
  }

  function pickScope(next: WorkAreaScope): void {
    setScope(next);
    if (next === 'world') {
      finalize('world', null);
      return;
    }
    push('country');
  }

  function pickCountry(picked: GeoCountry): void {
    setCountry(picked);
    if (scope === 'country') {
      finalize('country', picked);
      return;
    }
    push('region');
  }

  function pickRegion(picked: GeoRegion): void {
    setRegion(picked);
    if (scope === 'region') {
      finalize('region', picked);
      return;
    }
    push('city');
  }

  function skipRegion(): void {
    setRegion(null);
    push('city');
  }

  function pickCity(picked: GeoCity): void {
    finalize('city', picked);
  }

  if (!open) return null;

  const titles: Record<Step, string> = {
    scope: t('profile.workArea.scopeStepTitle'),
    country: t('profile.workArea.countryStepTitle'),
    region: t('profile.workArea.regionStepTitle'),
    city: t('profile.workArea.cityStepTitle'),
  };

  const cityEmpty = !citiesFetching && debouncedCityQuery.trim().length > 0 && (cities ?? []).length === 0;

  return (
    <Sheet open={open} title={titles[step]} onClose={handleClose} closeLabel={t('common.close')}>
      {step !== 'scope' ? (
        <button type="button" className={styles.back} onClick={goBack} data-testid="work-area-back">
          {t('profile.workArea.back')}
        </button>
      ) : null}

      {error ? (
        <p role="alert" className={styles.emptyText} data-testid="work-area-picker-error">
          {error}
        </p>
      ) : null}

      {step === 'scope' ? (
        <ul className={styles.list} data-testid="work-area-scope-list">
          {(['world', 'country', 'region', 'city'] as WorkAreaScope[]).map((s) => (
            <li key={s}>
              <button type="button" className={styles.row} onClick={() => pickScope(s)} data-testid={`work-area-scope-${s}`}>
                {t(`profile.workArea.scope.${s}`)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {step === 'country' ? (
        <>
          <TextField
            type="search"
            label={t('profile.workArea.countrySearchLabel')}
            placeholder={t('profile.workArea.countrySearchPlaceholder')}
            value={countryQuery}
            onChange={(e) => setCountryQuery(e.target.value)}
            data-testid="work-area-country-search"
          />
          <ul className={styles.list} data-testid="work-area-country-list">
            {filterCountries(countries ?? [], countryQuery, (code) => countryName(code, i18n.language)).map((c) => (
              <li key={c.code}>
                <button type="button" className={styles.row} onClick={() => pickCountry(c)} data-testid={`work-area-country-${c.code}`}>
                  {countryName(c.code, i18n.language)}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {step === 'region' ? (
        <>
          <TextField
            type="search"
            label={t('profile.workArea.regionSearchLabel')}
            placeholder={t('profile.workArea.regionSearchPlaceholder')}
            value={regionQuery}
            onChange={(e) => setRegionQuery(e.target.value)}
            data-testid="work-area-region-search"
          />
          {scope === 'city' ? (
            <button type="button" className={styles.skip} onClick={skipRegion} data-testid="work-area-region-skip">
              {t('profile.workArea.regionSkip')}
            </button>
          ) : null}
          <ul className={styles.list} data-testid="work-area-region-list">
            {(regions ?? []).map((r) => (
              <li key={r.code}>
                <button type="button" className={styles.row} onClick={() => pickRegion(r)} data-testid={`work-area-region-${r.code}`}>
                  {r.display_name}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {step === 'city' ? (
        <>
          <TextField
            type="search"
            label={t('profile.workArea.citySearchLabel')}
            placeholder={t('profile.workArea.citySearchPlaceholder')}
            value={cityQuery}
            onChange={(e) => setCityQuery(e.target.value)}
            data-testid="work-area-city-search"
          />
          {(cities ?? []).length > 0 ? (
            <ul className={styles.list} data-testid="work-area-city-list">
              {(cities ?? []).map((c) => (
                <li key={c.id}>
                  <button type="button" className={styles.row} onClick={() => pickCity(c)} data-testid={`work-area-city-${c.id}`}>
                    {c.display_name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {cityEmpty ? (
            <div className={styles.empty} data-testid="work-area-city-empty">
              <p className={styles.emptyText}>{t('profile.workArea.cityEmptyHint')}</p>
              <div className={styles.emptyActions}>
                {region ? (
                  <button
                    type="button"
                    className={styles.row}
                    onClick={() => finalize('region', region)}
                    data-testid="work-area-city-empty-region"
                  >
                    {t('profile.workArea.cityEmptyPickRegion', { name: region.display_name })}
                  </button>
                ) : null}
                {country ? (
                  <button
                    type="button"
                    className={styles.row}
                    onClick={() => finalize('country', country)}
                    data-testid="work-area-city-empty-country"
                  >
                    {t('profile.workArea.cityEmptyPickCountry', { name: countryName(country.code, i18n.language) })}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </Sheet>
  );
}
