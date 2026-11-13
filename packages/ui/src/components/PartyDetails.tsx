import { Icon } from './Icon';
import { TextField } from './Field';
import styles from './PartyDetails.module.css';

export type PartyDetailsMode = 'personal' | 'business';

interface FieldLabel {
  label: string;
  placeholder: string;
}

export interface PartyDetailsFieldLabels {
  fullName: FieldLabel;
  idDocument: FieldLabel;
  address: FieldLabel;
  orgName: FieldLabel;
  regNumber: FieldLabel;
  representative: FieldLabel;
}

export interface PartyDetailsProps {
  open: boolean;
  onToggleOpen: (open: boolean) => void;
  mode: PartyDetailsMode;
  onModeChange: (mode: PartyDetailsMode) => void;
  fields: Record<string, string>;
  onFieldChange: (key: string, value: string) => void;
  title: string;
  addLabel: string;
  collapseLabel: string;
  personalLabel: string;
  businessLabel: string;
  hint: string;
  /** Все текстовые строки полей — от вызывающего (i18n, глобальная версия — 6 языков). */
  fieldLabels: PartyDetailsFieldLabels;
}

/**
 * Реквизиты стороны (DEV-global-1, DEV-09 §5) — опционально, свёрнуто по умолчанию,
 * без валидации нац. форматов. Заполненное уходит в `form_data`, не в профиль/поиск/логи.
 */
export function PartyDetails({
  open,
  onToggleOpen,
  mode,
  onModeChange,
  fields,
  onFieldChange,
  title,
  addLabel,
  collapseLabel,
  personalLabel,
  businessLabel,
  hint,
  fieldLabels,
}: PartyDetailsProps): JSX.Element {
  if (!open) {
    return (
      <button type="button" className={styles.addBtn} onClick={() => onToggleOpen(true)} data-testid="party-details-open">
        <Icon name="plus" size={16} /> {addLabel}
      </button>
    );
  }

  const specs: { key: string; field: FieldLabel }[] =
    mode === 'business'
      ? [
          { key: 'org_name', field: fieldLabels.orgName },
          { key: 'reg_number', field: fieldLabels.regNumber },
          { key: 'representative', field: fieldLabels.representative },
          { key: 'address', field: fieldLabels.address },
        ]
      : [
          { key: 'full_name', field: fieldLabels.fullName },
          { key: 'id_document', field: fieldLabels.idDocument },
          { key: 'address', field: fieldLabels.address },
        ];

  return (
    <div className={styles.wrap} data-testid="party-details">
      <div className={styles.head}>
        <p className={styles.title}>{title}</p>
        <button type="button" className={styles.collapseBtn} onClick={() => onToggleOpen(false)}>
          {collapseLabel}
        </button>
      </div>
      <p className={styles.hint}>{hint}</p>
      <div className={styles.segmented} role="group" aria-label={title}>
        <button type="button" className={`${styles.segBtn} ${mode === 'personal' ? styles.segBtnActive : ''}`} onClick={() => onModeChange('personal')}>
          {personalLabel}
        </button>
        <button type="button" className={`${styles.segBtn} ${mode === 'business' ? styles.segBtnActive : ''}`} onClick={() => onModeChange('business')}>
          {businessLabel}
        </button>
      </div>
      {specs.map(({ key, field }) => (
        <TextField
          key={key}
          label={field.label}
          placeholder={field.placeholder}
          value={fields[key] ?? ''}
          onChange={(e) => onFieldChange(key, e.target.value)}
        />
      ))}
    </div>
  );
}
