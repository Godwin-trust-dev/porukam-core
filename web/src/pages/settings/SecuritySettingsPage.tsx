import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, SettingRow, Skeleton, Surface } from '@porukam/ui';
import { useCurrentUser } from '../../features/auth/useAuth';
import { useLogoutAllSessions, useLogoutSession, useSessions } from '../../features/profile/api';
import { useFormatters } from '../../shared/formatters';
import styles from './SecuritySettingsPage.module.css';

/** Настройки → безопасность (DEV-02 §5): сессии/устройства, статус верификации, смена телефона (заглушка). */
export function SecuritySettingsPage(): JSX.Element {
  const { t } = useTranslation();
  const { formatDateTime } = useFormatters();
  const navigate = useNavigate();
  const { data: me, isPending: mePending } = useCurrentUser();
  // На бэке нет `/sessions` (только мок) — ошибка запроса не должна вешать страницу:
  // карточка сессий рендерится лишь когда данные реально пришли.
  const { data: sessionsData } = useSessions();
  const logoutSession = useLogoutSession();
  const logoutAll = useLogoutAllSessions();

  if (mePending || !me) {
    return (
      <div className={styles.wrap}>
        <Skeleton width="100%" height={64} />
        <Skeleton width="100%" height={64} />
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      {sessionsData ? (
        <Card>
          <h3 className={styles.sectionTitle}>{t('profile.secSessionsTitle')}</h3>
          {sessionsData.results.map((s) => (
            <div key={s.id} className={styles.sessionRow}>
              <div className={styles.sessionInfo}>
                <span className={styles.sessionDevice}>{s.device}</span>
                <span className={styles.sessionMeta}>
                  {[s.location, formatDateTime(s.lastActiveAt)].filter(Boolean).join(' · ')}
                </span>
              </div>
              {s.current ? (
                <Badge tone="teal">{t('profile.secCurrentDevice')}</Badge>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => logoutSession.mutate(s.id)} loading={logoutSession.isPending}>
                  {t('profile.secLogoutDevice')}
                </Button>
              )}
            </div>
          ))}
          {sessionsData.results.length > 1 ? (
            <Button variant="ghost" onClick={() => logoutAll.mutate()} loading={logoutAll.isPending}>
              {t('profile.secLogoutAll')}
            </Button>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <div className={styles.verifRow}>
          <div>
            <h3 className={styles.sectionTitle}>{t('profile.secVerificationStatus')}</h3>
            <p className={styles.verifText}>{t('profile.verificationLevelLabel', { level: me.verificationLevel, max: 3 })}</p>
          </div>
          {me.verificationLevel < 3 ? (
            <Button variant="primary" onClick={() => navigate('/me/verify/esica')}>
              {t('profile.secUpgrade')}
            </Button>
          ) : null}
        </div>
      </Card>

      <Surface>
        <SettingRow label={t('profile.secPhoneChangeTitle')} hint={t('profile.secPhoneChangeSoon')} control="link" disabled onLinkClick={() => {}} />
      </Surface>
    </div>
  );
}
