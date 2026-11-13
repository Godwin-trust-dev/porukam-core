import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, EmptyState } from '@porukam/ui';
import styles from './EsicaStubPage.module.css';

/** Заглушка-маршрут ЕСИА-флоу (DEV-02 §4, §11 — вне скоупа: только вход). */
export function EsicaStubPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className={styles.wrap}>
      <EmptyState icon="verified" title={t('profile.esicaStubTitle')} text={t('profile.esicaStubText')} />
      <Button variant="ghost" onClick={() => navigate('/me')}>
        {t('common.back')}
      </Button>
    </div>
  );
}
