import { Spark } from './Spark';
import styles from './OnboardingDone.module.css';

export interface OnboardingDoneProps {
  title: string;
  subtitle?: string;
}

/**
 * Финал онбординга (§7 DEV-auth-onboarding) — короткое «Добро пожаловать»,
 * сдержанная искра: доверительное событие (правило 7 web/CLAUDE.md — Spark
 * только на вход/подписи, это ровно первый вход).
 */
export function OnboardingDone({ title, subtitle }: OnboardingDoneProps): JSX.Element {
  return (
    <div className={styles.wrap} data-testid="onboarding-done">
      <Spark size={96} title={title} />
      <h2 className={styles.title}>{title}</h2>
      {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
    </div>
  );
}
