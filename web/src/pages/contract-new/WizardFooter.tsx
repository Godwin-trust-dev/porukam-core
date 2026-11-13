import { useTranslation } from 'react-i18next';
import { Button } from '@porukam/ui';
import styles from './ContractNewPage.module.css';

export interface WizardFooterProps {
  onBack?: () => void;
  onNext?: () => void;
  nextDisabled?: boolean;
  nextLoading?: boolean;
  nextLabel?: string;
}

/**
 * Навигация шага мастера (DEV-09 §1) — «Назад»/«Далее», автосейв уже произошёл
 * до перехода. Доска B: на телефоне «Далее» — CTA во всю ширину под контентом,
 * на десктопе — обычная кнопка справа.
 */
export function WizardFooter({ onBack, onNext, nextDisabled, nextLoading, nextLabel }: WizardFooterProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className={styles.footer}>
      {onBack ? (
        <Button variant="ghost" onClick={onBack} className={styles.back} data-testid="wizard-back">
          {t('contractNew.back')}
        </Button>
      ) : (
        <span />
      )}
      {onNext ? (
        <Button
          variant="primary"
          onClick={onNext}
          disabled={nextDisabled}
          loading={nextLoading}
          className={styles.next}
          data-testid="wizard-next"
        >
          {nextLabel ?? t('contractNew.next')}
        </Button>
      ) : null}
    </div>
  );
}
