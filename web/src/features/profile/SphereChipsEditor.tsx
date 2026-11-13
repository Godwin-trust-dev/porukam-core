import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Icon, SpherePicker, type ButtonVariant } from '@porukam/ui';
import { useSpheres } from '../contractNew/api';
import { useDebounced } from '../../shared/useDebounced';
import styles from './SphereChipsEditor.module.css';

export const MAX_PROFILE_SPHERES = 10;

/**
 * Редактор заявленных сфер профиля (ADR-122): чипы выбранных + `SpherePicker`
 * каталога (та же выдача, что в мастере договора и у объединений). До 10.
 * Состояние — у родителя; компонент без сети, кроме каталога.
 */
export function SphereChipsEditor({
  value,
  onChange,
  hint,
  label,
  testId = 'profile-spheres',
  hideLabel = false,
  hideSearchLabel = false,
  collapsedByDefault = false,
  addVariant = 'secondary',
}: {
  value: string[];
  onChange: (codes: string[]) => void;
  hint?: string;
  /** Подпись блока; по умолчанию — «Сферы деятельности». */
  label?: string;
  testId?: string;
  /** Скрыть видимую подпись блока (ADR-189: панель фильтров поиска не дублирует
   * подпись — она и так одна на всю строку фильтров). Доступное имя не теряется —
   * уходит в `aria-label` обёртки, значение то же, что было бы видимой подписью. */
  hideLabel?: boolean;
  /** Прокидывается в `SpherePicker.hideSearchLabel` — снаружи уже есть видимая
   * подпись блока, свою подпись поля поиска внутри пикера показывать не нужно
   * (тот же приём, что и в форме объединения, ADR-097). */
  hideSearchLabel?: boolean;
  /** Не разворачивать пикер сразу при пустом выборе (как в формах профиля,
   * где это подталкивает заполнить сферы) — панель фильтров поиска (ADR-189)
   * должна оставаться компактной строкой, пока пикер не открыли явно. */
  collapsedByDefault?: boolean;
  /** Вид кнопки «Добавить сферу». По умолчанию тёмная `secondary` — в формах
   * профиля это действие формы. В панели фильтров поиска (ADR-192) — `outline`:
   * фильтр не действие экрана, он должен выглядеть как соседние контролы
   * (поле запроса, гео-кнопка, порог опыта), а не как три тёмные плашки. */
  addVariant?: ButtonVariant;
}): JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(!collapsedByDefault && value.length === 0);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const debounced = useDebounced(query, 250);
  const { data } = useSpheres(debounced);
  const { data: all } = useSpheres('');
  const nameOf = (code: string): string =>
    [...(all?.results ?? []), ...(all?.popular ?? []), ...(data?.results ?? [])].find((s) => s.code === code)?.name ?? code;
  const full = value.length >= MAX_PROFILE_SPHERES;
  const resolvedLabel = label ?? t('profile.formSpheresLabel');

  return (
    <div className={styles.wrap} data-testid={testId} role={hideLabel ? 'group' : undefined} aria-label={hideLabel ? resolvedLabel : undefined}>
      {hideLabel ? null : <span className={styles.label}>{resolvedLabel}</span>}
      {hint ? <p className={styles.hint}>{hint}</p> : null}
      {value.length > 0 ? (
        <div className={styles.chips} data-testid={`${testId}-chips`}>
          {value.map((code) => (
            <Badge key={code} tone="ink">
              {nameOf(code)}
              <button
                type="button"
                className={styles.remove}
                aria-label={`${t('profile.formSpheresRemove')}: ${nameOf(code)}`}
                onClick={() => onChange(value.filter((c) => c !== code))}
              >
                <Icon name="close" size={16} />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
      {full ? (
        <p className={styles.hint}>{t('profile.formSpheresLimit')}</p>
      ) : open ? (
        <SpherePicker
          query={query}
          onQueryChange={setQuery}
          results={data?.results}
          popular={data?.popular ?? []}
          showAll={showAll}
          onToggleShowAll={() => setShowAll((v) => !v)}
          searchLabel={t('contractNew.sphereSearchLabel')}
          hideSearchLabel={hideSearchLabel}
          searchPlaceholder={t('contractNew.sphereSearchPlaceholder')}
          popularLabel={t('contractNew.spherePopular')}
          browseAllLabel={t('contractNew.sphereBrowseAll')}
          emptyHint={t('contractNew.sphereEmptyHint')}
          onPick={(s) => {
            if (!value.includes(s.code)) onChange([...value, s.code]);
            setQuery('');
            setShowAll(false);
            setOpen(false);
          }}
        />
      ) : (
        <div>
          <Button size="sm" variant={addVariant} leftIcon={<Icon name="plus" size={16} />} onClick={() => setOpen(true)} data-testid={`${testId}-add`}>
            {t('profile.formSpheresAdd')}
          </Button>
        </div>
      )}
    </div>
  );
}
