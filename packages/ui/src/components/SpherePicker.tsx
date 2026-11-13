import type { Sphere, WorkTypeHit } from '@porukam/core';
import { Icon } from './Icon';
import { TextField } from './Field';
import styles from './SpherePicker.module.css';

export interface SpherePickerProps {
  query: string;
  onQueryChange: (q: string) => void;
  /** Результаты поиска (пусто = ничего не найдено, undefined = запрос ещё не вводился). */
  results?: Sphere[];
  popular: Sphere[];
  onPick: (sphere: Sphere) => void;
  /** Типы работ, совпавшие с запросом (ADR-100) — показываются ПЕРВЫМИ:
   * «мебель» → «Мебель: сборка и ремонт · Ремонт и строительство». */
  workTypes?: WorkTypeHit[];
  onPickWorkType?: (hit: WorkTypeHit) => void;
  /** Код уже выбранного типа работ — подсветка строки. */
  selectedWorkTypeCode?: string;
  /** Код уже выбранной сферы — подсвечивается в чипах и строках (ADR-097:
   * прежде пикер не знал о выборе, и повторный поиск выглядел так, будто
   * выбор «не меняется»). */
  selectedCode?: string;
  /** «Все сферы» — полный список без фильтра поиском. */
  showAll?: boolean;
  onToggleShowAll?: () => void;
  /** Все текстовые строки — от вызывающего (i18n, DEV-09 памятка: 6 языков в глобальной версии). */
  searchLabel: string;
  /** Подпись поля поиска — только для скринридера (`aria-label`): когда у
   * пикера уже есть своя подпись снаружи («Сфера деятельности *» в форме
   * объединения), вторая видимая подпись дублирует первую. */
  hideSearchLabel?: boolean;
  searchPlaceholder: string;
  popularLabel: string;
  browseAllLabel: string;
  emptyHint: string;
  /** Заголовок блока типов работ в выдаче (ADR-100). */
  workTypesLabel?: string;
  /** Заголовок блока сфер в выдаче — виден, когда рядом есть и типы работ. */
  spheresLabel?: string;
}

/** Сфера/тип работ поиском (DEV-09 §3) — популярные сверху, поиск с
 * подсказками (нечёткий матч и ранжирование — на сервере/в моке, ADR-097),
 * «все сферы». */
export function SpherePicker({
  query,
  onQueryChange,
  results,
  popular,
  onPick,
  workTypes = [],
  onPickWorkType,
  selectedWorkTypeCode,
  selectedCode,
  showAll,
  onToggleShowAll,
  searchLabel,
  hideSearchLabel = false,
  searchPlaceholder,
  popularLabel,
  browseAllLabel,
  emptyHint,
  workTypesLabel,
  spheresLabel,
}: SpherePickerProps): JSX.Element {
  const searching = query.trim().length > 0;
  const workTypeHits = searching && onPickWorkType ? workTypes : [];
  // «Популярные» — только вне поиска/полного списка и только если они есть
  // (real-бэкенд отдаёт popular: [] — пустую секцию не рисуем).
  const showPopular = !searching && !showAll && popular.length > 0;

  return (
    <div className={styles.wrap}>
      <TextField
        label={hideSearchLabel ? undefined : searchLabel}
        aria-label={hideSearchLabel ? searchLabel : undefined}
        placeholder={searchPlaceholder}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        data-testid="sphere-search"
      />

      {showPopular ? (
        <div className={styles.section}>
          <p className={styles.sectionTitle}>{popularLabel}</p>
          <div className={styles.chips}>
            {popular.map((s) => (
              <button
                key={s.code}
                type="button"
                className={s.code === selectedCode ? `${styles.chip} ${styles.chipActive}` : styles.chip}
                aria-pressed={s.code === selectedCode}
                onClick={() => onPick(s)}
                data-testid={`sphere-${s.code}`}
              >
                {s.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* Переключатель живёт вне секции «Популярных»: после включения «всех сфер»
          он остаётся на экране (aria-pressed) — иначе выключить режим нельзя было бы. */}
      {!searching && onToggleShowAll ? (
        <button
          type="button"
          className={styles.browseAll}
          onClick={onToggleShowAll}
          aria-pressed={!!showAll}
          data-testid="sphere-browse-all"
        >
          <Icon name="search" size={16} /> {browseAllLabel}
        </button>
      ) : null}

      {workTypeHits.length > 0 ? (
        <div className={styles.section} data-testid="work-type-hits">
          {workTypesLabel ? <p className={styles.sectionTitle}>{workTypesLabel}</p> : null}
          <ul className={styles.list}>
            {workTypeHits.map((w) => {
              const active = w.code === selectedWorkTypeCode && w.sphere_code === selectedCode;
              return (
                <li key={`${w.sphere_code}.${w.code}`}>
                  <button
                    type="button"
                    className={active ? `${styles.row} ${styles.rowActive}` : styles.row}
                    aria-pressed={active}
                    onClick={() => onPickWorkType?.(w)}
                    data-testid={`work-type-hit-${w.code}`}
                  >
                    <span className={styles.hitName}>{w.name}</span>
                    <span className={styles.hitSphere}>{w.sphere_name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {(searching || showAll) && (
        <div className={styles.section}>
          {(results ?? []).length > 0 && workTypeHits.length > 0 && spheresLabel ? (
            <p className={styles.sectionTitle}>{spheresLabel}</p>
          ) : null}
          {(results ?? []).length > 0 ? (
            <ul className={styles.list}>
              {(results ?? []).map((s) => (
                <li key={s.code}>
                  <button
                    type="button"
                    className={s.code === selectedCode ? `${styles.row} ${styles.rowActive}` : styles.row}
                    aria-pressed={s.code === selectedCode}
                    onClick={() => onPick(s)}
                    data-testid={`sphere-${s.code}`}
                  >
                    {s.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : results === undefined || workTypeHits.length > 0 ? null : (
            <p className={styles.empty}>{emptyHint}</p>
          )}
        </div>
      )}
    </div>
  );
}
