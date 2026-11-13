import type { ReactNode } from 'react';
import { Card } from './Card';
import { Checkbox } from './Checkbox';
import { Button } from './Button';
import styles from './ConsentAgree.module.css';

export interface ConsentAgreeProps {
  title: string;
  body: ReactNode;
  readMoreLabel?: string;
  onReadMore?: () => void;
  /** Раскрыт ли `expandedText` (докладчик-состояние — экран владеет тумблером). */
  readMoreExpanded?: boolean;
  /** Полный текст согласия (docs/tasks/Задача_fix_web-consents-crash.md,
   * «Дополнительно») — показывается под `body`, когда `readMoreExpanded`. */
  expandedText?: ReactNode;
  agreeLabel: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Обязательное согласие (§5) — без него «Продолжить» недоступна. */
  required?: boolean;
}

/**
 * Одно обязательное согласие шага «Данные и приватность» (`ConsentsStep`,
 * DEV-auth-onboarding §5) — канон `legal-global/03`: «мы — оператор сервиса,
 * а не сторона сделок» / карточка репутации. Чекбокс всегда стартует
 * НЕвыбранным (silence ≠ согласие) — компонент не задаёт дефолт сам.
 */
export function ConsentAgree({
  title,
  body,
  readMoreLabel,
  onReadMore,
  readMoreExpanded,
  expandedText,
  agreeLabel,
  checked,
  onChange,
  required,
}: ConsentAgreeProps): JSX.Element {
  return (
    <Card className={styles.card}>
      <h3 className={styles.title}>{title}</h3>
      <p className={styles.body}>{body}</p>
      {readMoreExpanded && expandedText ? <p className={styles.body}>{expandedText}</p> : null}
      {readMoreLabel ? (
        <Button
          variant="ghost"
          size="sm"
          className={styles.readMore}
          onClick={onReadMore}
          aria-expanded={onReadMore ? (readMoreExpanded ?? false) : undefined}
        >
          {readMoreLabel}
        </Button>
      ) : null}
      <Checkbox checked={checked} onChange={onChange} label={agreeLabel} required={required} />
    </Card>
  );
}
