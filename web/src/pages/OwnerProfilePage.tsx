import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@porukam/core';
import {
  Button,
  EmptyState,
  ErrorState,
  Icon,
  Modal,
  PassportHeader,
  Skeleton,
  StatTile,
  Surface,
  type IconName,
} from '@porukam/ui';
import { useCurrentUser } from '../features/auth/useAuth';
import { useNotificationsSummary } from '../features/notifications/api';
import { useSavedContacts } from '../features/contacts/api';
import { findOwnPersonProfileId, useOwnProfileSettings } from '../features/profile/api';
import styles from './OwnerProfilePage.module.css';
import { SphereChips } from '../features/profile/SphereChips';
import { copyToClipboard } from '../shared/clipboard';
import { apiErrorText } from '../shared/apiErrorText';

// Отсмотр 2026-08-19: бейдж «Базовая верификация» и шкала «Верификация N / 3»
// СПРЯТАНЫ, пока верификация не станет содержательной (реальный /users/me и не
// отдаёт numeric-уровень — шкала на проде рисовала пустые «Верификация  / 3»).
// Компоненты остаются в @porukam/ui; ключи profile.verification* — в словарях.
//
// Замечание владельца 03.09 (финал доска A): большого баннера под шапкой
// профиля («важное уведомление» NextStepSlot, ЕСИА-предложение) на экране
// нет — важное живёт в ленте, а на плитке «Уведомл.» стоит счётчик.
// `NextStepSlot` остаётся в @porukam/ui; маршрут /me/verify/esica цел.

/**
 * Меню профиля — РОВНО ТРИ строки, как на финале доски A
 * (`marketing/reference/front-upgrade/ref15_finalA_1.png`, экран «Профиль»):
 * «Мои сделки · Что такое По рукам · Настройки». Отдельной строки «Вопросы и
 * ответы» на доске нет: FAQ живёт ВНУТРИ «Что такое По рукам» (кнопка
 * «Вопросы и ответы» внизу `AboutPage`), маршрут `/help/faq` цел, ключ
 * `profile.linkFaq` остаётся в словарях.
 */
const MENU: Array<{ key: string; labelKey: string; to: string; icon: IconName; testId?: string }> = [
  { key: 'deals', labelKey: 'profile.linkMyDeals', to: '/contracts', icon: 'deals' },
  { key: 'about', labelKey: 'profile.linkAbout', to: '/help/about', icon: 'info', testId: 'link-about' },
  { key: 'settings', labelKey: 'profile.linkSettings', to: '/me/settings', icon: 'settings', testId: 'link-settings' },
];

/**
 * Хаб владельца `/me` (DEV-02 §3, финал доска A): паспорт-карточка (light),
 * под ней ряд действий «Редактировать · Как гость · поделиться», плитки 3×1
 * «Уведомл. · Контакты · Портфолио», затем меню hairline-строками.
 */
export function OwnerProfilePage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: me, isPending, error, refetch } = useCurrentUser();
  const notifications = useNotificationsSummary();
  const { data: contacts } = useSavedContacts();
  // city/remote — apps.profiles, не apps.accounts (ADR-087, docs/tasks/
  // Задача_fix_web-profile-settings-real-api.md): `/v1/users/me` их не отдаёт.
  const { data: profile } = useOwnProfileSettings(findOwnPersonProfileId(me?.profiles));
  const [shareOpen, setShareOpen] = useState(false);
  // Отсмотр 2026-08-23: «фото при нажатии не увеличивается» — кнопка-лупа
  // PassportHeader была без обработчика.
  const [avatarOpen, setAvatarOpen] = useState(false);

  if (isPending) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>
          <Skeleton width={88} height={88} radius="50%" />
          <Skeleton width="40%" height={28} />
          <Skeleton width="60%" height={16} />
          <Skeleton width="100%" height={80} />
        </div>
      </div>
    );
  }

  if (error) {
    if (error instanceof ApiError && error.code === 'unauthorized') {
      return (
        <div className={styles.page}>
          <EmptyState icon="profile" title={t('profile.gateNotFoundTitle')} text={t('profile.gateNotFoundText')} />
        </div>
      );
    }
    return (
      <div className={styles.page}>
        <ErrorState
          title={t('reputation.errorTitle')}
          text={apiErrorText(error)}
          code={error instanceof ApiError ? error.code : undefined}
          retryLabel={t('common.retry')}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  if (!me) return <></>;

  // about/spheres — убраны (ADR-087, Tier B, нет на боевом бэке вообще); city —
  // единственный оставшийся честный сигнал «профиль пуст».
  const isEmptyProfile = !profile?.city_name;
  // `me.handle` — `null` до шага «Профиль» онбординга (docs/tasks/
  // Задача_fix_web-profile-handle-real-api.md); этот экран гарантированно
  // за `RequireGlobalOnboarding` (handle уже заявлен), фолбэк — только чтобы
  // не подставлять буквальный "null" в URL/пропсы, если инвариант когда-то нарушится.
  const handle = me.handle ?? '';
  const shareUrl = `${window.location.origin}/${handle}`;
  async function copyHandle(): Promise<void> {
    if (handle) await copyToClipboard(handle.startsWith('@') ? handle : `@${handle}`);
  }

  return (
    <div className={styles.page}>
      <div className={styles.layout}>
        <PassportHeader
          surface="light"
          name={me.display_name}
          handle={handle}
          onCopyHandle={() => void copyHandle()}
          copyHandleLabel={t('common.copyHandle')}
          copiedLabel={t('common.copied')}
          city={profile?.city_name || undefined}
          remote={profile?.works_remotely ?? false}
          remoteLabel={t('reputation.remoteAnyCity')}
          avatarUrl={profile?.avatar_url ?? undefined}
          expandLabel={t('reputation.expandAvatar')}
          onAvatarClick={() => setAvatarOpen(true)}
          // Действия стоят ПОД карточкой (финал доска A), не внутри неё.
          actions={null}
        />
        <SphereChips codes={profile?.sphere_codes ?? []} testId="me-spheres" />

        {/* Финал доска A: «Редактировать» (янтарь, шире), «Как гость» и
            «поделиться» — белые с рамкой, одной строкой. */}
        <div className={styles.actions} data-testid="me-actions">
          <Button variant="primary" size="sm" className={styles.editBtn} onClick={() => navigate('/me/settings/profile')}>
            {t('profile.editShort')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => navigate(`/${handle}`)}>
            {t('profile.viewAsGuestShort')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={styles.shareBtn}
            aria-label={t('profile.share')}
            title={t('profile.share')}
            onClick={() => setShareOpen(true)}
          >
            <Icon name="share" size={16} />
          </Button>
        </div>

        <div className={styles.tiles}>
          <StatTile
            icon="bell"
            label={t('nav.notificationsShort')}
            badge={notifications?.unread_count}
            onClick={() => navigate('/notifications')}
          />
          <StatTile
            icon="profile"
            label={t('profile.statContactsShort')}
            badge={contacts?.length || undefined}
            onClick={() => navigate('/me/contacts')}
          />
          <StatTile icon="contract" label={t('profile.statPortfolio')} onClick={() => navigate('/me/portfolio')} />
        </div>

        {/* Пустой профиль — одна строка-подсказка в ритме меню, не карточка. */}
        {isEmptyProfile ? (
          <Surface bleed>
            <button type="button" className={styles.linkRow} onClick={() => navigate('/me/settings/profile')} data-testid="me-empty-hint">
              <Icon name="edit" size={20} className={styles.rowIcon} />
              <span className={styles.rowText}>
                <span>{t('profile.emptyHubTitle')}</span>
                <span className={styles.rowHint}>{t('profile.emptyHubText')}</span>
              </span>
              <Icon name="back" size={16} className={styles.chevron} directional />
            </button>
          </Surface>
        ) : null}

        {/* ADR-163 §8: вход в приватный разбор своей репутации. ОТДЕЛЬНОЙ
            поверхностью над меню, а не четвёртой строкой в нём: «меню —
            ровно три строки» — решение владельца по финалу доски A, и
            размывать его новой задачей нельзя. Кнопкой на публичной
            карточке этот вход тоже быть не может: карточку открывают
            гости, а разбор — только свой. */}
        <Surface bleed data-testid="me-reputation">
          <button
            type="button"
            className={styles.linkRow}
            onClick={() => navigate('/me/reputation')}
            data-testid="link-reputation-insights"
          >
            <Icon name="reputation" size={20} className={styles.rowIcon} />
            <span className={styles.rowText}>{t('reputation.insightsMenuLabel')}</span>
            <Icon name="back" size={16} className={styles.chevron} directional />
          </button>
        </Surface>

        {/* Меню — строки на поверхности с hairline и значками (финал доска A). */}
        <Surface bleed data-testid="me-menu">
          {MENU.map((item) => (
            <button key={item.key} type="button" className={styles.linkRow} onClick={() => navigate(item.to)} data-testid={item.testId}>
              <Icon name={item.icon} size={20} className={styles.rowIcon} />
              <span className={styles.rowText}>{t(item.labelKey)}</span>
              <Icon name="back" size={16} className={styles.chevron} directional />
            </button>
          ))}
        </Surface>
      </div>

      <Modal
        open={avatarOpen}
        title={t('reputation.expandAvatar')}
        onClose={() => setAvatarOpen(false)}
        closeLabel={t('common.close')}
      >
        {profile?.avatar_url ? (
          <img
            src={profile?.avatar_url}
            alt={t('profile.avatarAlt')}
            style={{ width: '100%', borderRadius: 12 }}
            data-testid="avatar-lightbox"
          />
        ) : null}
      </Modal>
      <Modal open={shareOpen} title={t('reputation.shareTitle')} onClose={() => setShareOpen(false)} closeLabel={t('common.close')}>
        <div className={styles.shareBody}>
          <div className={styles.qrPlaceholder} aria-hidden="true">
            <Icon name="visible" size={32} />
          </div>
          <label className={styles.shareField}>
            <span>{t('reputation.qrLinkLabel')}</span>
            <input type="text" readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} />
          </label>
        </div>
      </Modal>
    </div>
  );
}
