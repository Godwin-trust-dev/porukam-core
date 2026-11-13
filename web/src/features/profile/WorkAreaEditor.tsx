import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Icon } from '@porukam/ui';
import type { WorkArea, WorkAreaScope } from '@porukam/core';
import { WorkAreaPickerSheet } from './WorkAreaPickerSheet';
import { WORK_AREA_MAX, tempWorkAreaId, workAreaKey, workAreaLabel } from './workAreaHelpers';
import styles from './WorkAreaEditor.module.css';

/**
 * Редактор «Где я работаю» (план 11.09 §4, ADR-182) — та же форма, что
 * `SphereChipsEditor` (чипы выбранного + кнопка «Добавить», состояние — у
 * родителя, сохраняется вместе с остальной формой по «Сохранить»/
 * «Продолжить»), только выбор — каскадный (`WorkAreaPickerSheet`), не
 * плоский список.
 *
 * ЗАМЕНИЛ отдельную галочку «Работаю удалённо» — «весь мир» здесь и есть
 * прежний смысл этой галочки (план 11.09 §4 п.3), только теперь это ОДНА
 * из до пяти записей, а не единственный переключатель.
 */
export function WorkAreaEditor({
  value,
  onChange,
  label,
  hint,
  testId = 'work-areas',
}: {
  value: WorkArea[];
  onChange: (next: WorkArea[]) => void;
  label?: string;
  hint?: string;
  testId?: string;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const full = value.length >= WORK_AREA_MAX;
  const worldLabel = t('profile.workArea.scope.world');

  function remove(id: string): void {
    onChange(value.filter((v) => v.id !== id));
  }

  /** Дубль/лимит — понятная подсказка ДО сервера (владелец 11.09), не 422
   * постфактум: сервер (`services.replace_work_areas`) те же правила
   * проверяет тоже, но это на случай гонки (два вкладки/устройства), не
   * основной путь. */
  function tryAdd(scope: WorkAreaScope, location: WorkArea['location']): string | null {
    if (value.length >= WORK_AREA_MAX) return t('profile.workArea.limit');
    const key = workAreaKey({ scope, location });
    if (value.some((v) => workAreaKey(v) === key)) return t('profile.workArea.duplicate');
    onChange([...value, { id: tempWorkAreaId(), scope, location, created_at: new Date().toISOString() }]);
    return null;
  }

  return (
    <div className={styles.wrap} data-testid={testId}>
      <span className={styles.label}>{label ?? t('profile.workArea.label')}</span>
      {hint ? <p className={styles.hint}>{hint}</p> : null}
      {value.length > 0 ? (
        <div className={styles.chips} data-testid={`${testId}-chips`}>
          {value.map((area) => (
            <Badge key={area.id} tone="ink">
              {workAreaLabel(area, i18n.language, worldLabel)}
              <button
                type="button"
                className={styles.remove}
                aria-label={`${t('profile.workArea.remove')}: ${workAreaLabel(area, i18n.language, worldLabel)}`}
                onClick={() => remove(area.id)}
                data-testid={`${testId}-remove-${area.id}`}
              >
                <Icon name="close" size={16} />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
      {full ? (
        <p className={styles.hint}>{t('profile.workArea.limit')}</p>
      ) : (
        <div>
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Icon name="plus" size={16} />}
            onClick={() => setPickerOpen(true)}
            data-testid={`${testId}-add`}
          >
            {t('profile.workArea.add')}
          </Button>
        </div>
      )}
      <WorkAreaPickerSheet open={pickerOpen} onClose={() => setPickerOpen(false)} onPick={tryAdd} />
    </div>
  );
}
