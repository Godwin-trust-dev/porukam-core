import { Card } from './Card';
import { RadioGroup } from './RadioGroup';
import styles from './VisibilityChoice.module.css';

export type ProfileVisibilityValue = 'public' | 'link_and_deals';

export interface VisibilityChoiceProps {
  title: string;
  /** `null` — ничего не выбрано (без дефолта, §5 DEV-auth-onboarding). */
  value: ProfileVisibilityValue | null;
  onChange: (value: ProfileVisibilityValue) => void;
  publicLabel: string;
  publicBadge?: string;
  linkOnlyLabel: string;
  hint?: string;
  ariaLabel: string;
}

/**
 * «Кто видит ваш профиль?» (`ConsentsStep`, DEV-auth-onboarding §5) — выбор
 * из двух БЕЗ дефолта; `value: null` — валидное стартовое состояние, не
 * ошибка. Значения совпадают с булевым согласием `profile_public` на бэке
 * (true → 'public', false → 'link_and_deals', ADR-067).
 */
export function VisibilityChoice({
  title,
  value,
  onChange,
  publicLabel,
  publicBadge,
  linkOnlyLabel,
  hint,
  ariaLabel,
}: VisibilityChoiceProps): JSX.Element {
  return (
    <Card className={styles.card}>
      <h3 className={styles.title}>{title}</h3>
      <RadioGroup
        ariaLabel={ariaLabel}
        value={value}
        onChange={(v) => onChange(v as ProfileVisibilityValue)}
        options={[
          { value: 'public', label: publicLabel, badge: publicBadge },
          { value: 'link_and_deals', label: linkOnlyLabel },
        ]}
      />
      {hint ? <p className={styles.hint}>{hint}</p> : null}
    </Card>
  );
}
