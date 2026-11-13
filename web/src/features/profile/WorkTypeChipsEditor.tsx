import { useQueries } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSpheres, workTypesQueryOptions } from '../contractNew/api';
import styles from './WorkTypeChipsEditor.module.css';

export const PROFILE_MAX_WORK_TYPES = 30;

/**
 * «Сфера → её виды работ» (ADR-190/191) — ровно то, что просил владелец
 * («пусть через поиск сферу находят. а ниже к сфере выдаётся перечень видов
 * работ. как у нас в договоре»): под КАЖДОЙ сферой из `spheres` разворачивается
 * список её видов работ (`GET /v1/work-types?sphere=`, тот же справочник, что
 * `SphereStep` мастера договора), множественный выбор простым тумблером —
 * никакого второго уровня поиска внутри списка, никакого нового справочника.
 *
 * ОДИН компонент — и в профиле (`ProfileSettingsPage`, под `SphereChipsEditor`),
 * и в панели фильтров поиска (`SearchPage`, под фильтром сфер): `spheres` —
 * это ТЕКУЩИЙ список заявленных/выбранных сфер вызывающей стороны (значение
 * `SphereChipsEditor.value`), `value`/`onChange` — составные коды
 * `<сфера>.<категория>`, формат `Profile.work_type_codes`/`?work_type=`.
 *
 * Без сфер — рендерить нечего (нет родителя, под которым разворачивать
 * список), компонент возвращает `null`.
 *
 * «Снятие сферы снимает и её виды работ» (ADR-191) — ОТВЕТСТВЕННОСТЬ
 * ВЫЗЫВАЮЩЕЙ СТОРОНЫ, не этого компонента: `ProfileSettingsPage`/`SearchPage`
 * режут осиротевшие коды из `value` синхронно В ТОМ ЖЕ обработчике, где
 * `SphereChipsEditor` теряет сферу. Компонент НЕ подчищает `value` сам —
 * иначе прямая ссылка `/search?work_type=repair.repair_kitchen` БЕЗ
 * `sphere=repair` в URL (валидный независимый фильтр, ADR-190 §3: сфера и
 * вид работ друг друга не проверяют) тут же лишилась бы своего параметра
 * при первом же рендере, до того как человек вообще коснулся панели.
 * Здесь `spheres` влияет ТОЛЬКО на то, какие группы видны — не на `value`.
 */
export function WorkTypeChipsEditor({
  spheres,
  value,
  onChange,
  label,
  hint,
  testId = 'profile-work-types',
  hideLabel = false,
  max,
}: {
  /** Сферы, под которыми разворачивается список их видов работ — заявленные
   * сферы профиля ИЛИ выбранные сферы фильтра поиска, у вызывающей стороны
   * уже есть готовый список (`SphereChipsEditor.value`). */
  spheres: string[];
  /** Составные коды `<сфера>.<категория>`. */
  value: string[];
  onChange: (codes: string[]) => void;
  /** Подпись блока; по умолчанию — «Виды работ». */
  label?: string;
  hint?: string;
  testId?: string;
  /** Скрыть видимую подпись блока (тот же приём, что `SphereChipsEditor.hideLabel`,
   * ADR-189) — доступное имя уходит в `aria-label` группы. */
  hideLabel?: boolean;
  /** Лимит одновременно выбранных видов работ — 30 в профиле (ADR-190,
   * `PROFILE_MAX_WORK_TYPES`), без лимита в панели фильтров поиска (`undefined`). */
  max?: number;
}): JSX.Element | null {
  const { t } = useTranslation();
  const { data: allSpheres } = useSpheres('');
  const sphereNameOf = (code: string): string =>
    allSpheres?.results.find((s) => s.code === code)?.name ?? allSpheres?.popular.find((s) => s.code === code)?.name ?? code;

  const workTypeQueries = useQueries({ queries: spheres.map((code) => workTypesQueryOptions(code)) });

  if (spheres.length === 0) return null;

  const resolvedLabel = label ?? t('profile.workType.label');
  const full = max != null && value.length >= max;

  return (
    <div className={styles.wrap} data-testid={testId} role={hideLabel ? 'group' : undefined} aria-label={hideLabel ? resolvedLabel : undefined}>
      {hideLabel ? null : <span className={styles.label}>{resolvedLabel}</span>}
      {hint ? <p className={styles.hint}>{hint}</p> : null}
      {full ? <p className={styles.hint}>{t('profile.workType.limit')}</p> : null}
      {spheres.map((sphereCode, i) => {
        const items = workTypeQueries[i]?.data ?? [];
        if (items.length === 0) return null;
        return (
          <div key={sphereCode} className={styles.group} data-testid={`${testId}-group-${sphereCode}`}>
            <span className={styles.groupLabel}>{sphereNameOf(sphereCode)}</span>
            <div className={styles.chips}>
              {items.map((w) => {
                const composite = `${sphereCode}.${w.code}`;
                const selected = value.includes(composite);
                return (
                  <button
                    key={composite}
                    type="button"
                    className={`${styles.chip} ${selected ? styles.chipActive : ''}`}
                    aria-pressed={selected}
                    disabled={!selected && full}
                    onClick={() => onChange(selected ? value.filter((c) => c !== composite) : [...value, composite])}
                    data-testid={`work-type-${composite}`}
                  >
                    {w.name}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
