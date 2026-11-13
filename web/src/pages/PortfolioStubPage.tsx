import { useTranslation } from 'react-i18next';
import { EmptyState } from '@porukam/ui';

/** Заглушка `/me/portfolio` — полноценный менеджер портфолио отдельной задачей (DEV-03, §11). */
export function PortfolioStubPage(): JSX.Element {
  const { t } = useTranslation();
  return <EmptyState icon="contract" title={t('profile.statPortfolio')} text={t('common.soon')} />;
}
