import { useMemo, useState } from 'react';
import type { LocaleInfo } from '@porukam/core';
import { SearchInput } from './SearchInput';
import { LocaleRow } from './LocaleRow';
import { Skeleton } from './States';
import { Button } from './Button';
import styles from './LocaleList.module.css';
import { normalizeForSearch } from './searchNormalize';

export interface LocaleListProps {
  locales: LocaleInfo[];
  currentCode: string;
  onSelect: (locale: LocaleInfo) => void;
  loading?: boolean;
  errorText?: string;
  onRetry?: () => void;
  retryLabel?: string;
  searchPlaceholder: string;
  searchAriaLabel: string;
  searchClearLabel: string;
  currentSectionTitle: string;
  allSectionTitle: string;
  noResultsText: string;
  betaLabel: string;
  betaTooltip: string;
  currentAriaLabel: string;
}

const normalize = normalizeForSearch;

function matches(locale: LocaleInfo, query: string): boolean {
  return [locale.self_name, locale.english_name, locale.code].some((f) => normalize(f).includes(query));
}

/**
 * Список языков (DEV-16a §2): поиск по само-названию/английскому/коду (регистро- и
 * диакритиконечувствительно) · секция «Текущий» → «Все языки» (алфавит по self_name),
 * при активном поиске — плоский список · `role=listbox`/`option`.
 */
export function LocaleList({
  locales,
  currentCode,
  onSelect,
  loading,
  errorText,
  onRetry,
  retryLabel,
  searchPlaceholder,
  searchAriaLabel,
  searchClearLabel,
  currentSectionTitle,
  allSectionTitle,
  noResultsText,
  betaLabel,
  betaTooltip,
  currentAriaLabel,
}: LocaleListProps): JSX.Element {
  const [query, setQuery] = useState('');
  const normalizedQuery = normalize(query);
  const searching = normalizedQuery.length > 0;

  const current = locales.find((l) => l.code === currentCode);
  const rest = useMemo(() => {
    const pool = searching ? locales.filter((l) => matches(l, normalizedQuery)) : locales.filter((l) => l.code !== currentCode);
    // (a.self_name ?? '') — не через normalize(): localeCompare тут должен
    // сохранять настоящую коллацию (регистр/диакритику), normalize() нужен
    // только для нечувствительного поиска в matches() выше.
    // Коллация ЯВНО 'en' (отсмотр 2026-08-19): без неё порядок зависит от
    // языка браузера — ru-коллация ставит кириллицу ПЕРЕД латиницей
    // («Қазақша, Українська, Azərbaycanca…»), что читается как отсутствие
    // сортировки. en-корневой порядок (Latin → Cyrillic → остальные
    // письменности) одинаков у всех и привычен по спискам языков.
    return [...pool].sort((a, b) => (a.self_name ?? '').localeCompare(b.self_name ?? '', 'en'));
  }, [locales, searching, normalizedQuery, currentCode]);

  const rowProps = { betaLabel, betaTooltip, currentAriaLabel, onSelect };

  return (
    <div className={styles.wrap}>
      <SearchInput value={query} onChange={setQuery} placeholder={searchPlaceholder} clearLabel={searchClearLabel} label={searchAriaLabel} />
      {loading ? (
        <div className={styles.skeletons}>
          <Skeleton height={44} radius="8px" />
          <Skeleton height={44} radius="8px" />
          <Skeleton height={44} radius="8px" />
        </div>
      ) : errorText ? (
        <div className={styles.error} role="alert">
          <span>{errorText}</span>
          {onRetry && retryLabel ? (
            <Button variant="ghost" size="sm" onClick={onRetry}>
              {retryLabel}
            </Button>
          ) : null}
        </div>
      ) : (
        <div role="listbox" aria-label={searchAriaLabel} className={styles.list}>
          {!searching && current ? (
            <>
              <div className={styles.sectionTitle}>{currentSectionTitle}</div>
              <LocaleRow locale={current} current {...rowProps} />
              <div className={styles.sectionTitle}>{allSectionTitle}</div>
            </>
          ) : null}
          {rest.length === 0 ? (
            <p className={styles.empty}>{noResultsText}</p>
          ) : (
            rest.map((l) => <LocaleRow key={l.code} locale={l} current={l.code === currentCode} {...rowProps} />)
          )}
        </div>
      )}
    </div>
  );
}
