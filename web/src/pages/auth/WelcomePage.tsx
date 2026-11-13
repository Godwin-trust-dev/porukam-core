import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { LegalDocSlug } from '@porukam/core';
import { Button, CookieBanner, GoogleButton, InviteBanner, LanguageSwitcher, Logo, Skeleton, Toast } from '@porukam/ui';
import { LegalDocumentDialog } from '../../features/legal/LegalDocumentDialog';
import { useGoogleAuthorizeUrl } from '../../features/auth/useAuth';
import { takeAccountDeletedNotice } from '../../features/auth/accountDeletedNotice';
import { EMAIL_LOGIN_ENABLED } from '../../features/auth/emailLoginFlag';
import { useInvite } from '../../features/onboarding/api';
import { setPendingInvite } from '../../features/onboarding/inviteContext';
import {
  getCookieChoice,
  markCookieBannerShown,
  setCookieChoice,
  wasCookieBannerShown,
  type CookieChoice,
} from '../../features/onboarding/cookieChoice';
import { useLanguageSwitcherProps } from '../../features/locale/useLanguageSwitcherProps';
import { publicPath } from '../../features/publicSite/pages';
import { isAppWrapper } from '../../features/pwa/appWrapper';
import styles from './AuthScreen.module.css';

/**
 * Вход (GLOBAL У1, DEV-auth-onboarding §3): холодный вход или по приглашению
 * (`?invite=<token>`). Только Google — без телефона/пароля (§4). ToS-акцепт —
 * действием кнопки (не отдельный чекбокс, текст со ссылками рядом).
 *
 * DEV-16a §6 — chip переключателя языка над кнопкой Google: раньше экран принудительно
 * держался на `en` (`useForceLocale`, единственный EN-переведённый на тот момент срез,
 * см. историю); теперь язык интерфейса выбирает/определяет `useLocaleResolution`
 * (смонтирован у корня, `AppProviders`) — этот хук здесь больше не нужен.
 *
 * Ссылки «Условия использования» / «Политика конфиденциальности» открывают
 * РЕАЛЬНЫЙ документ на текущем языке (`LegalDocumentDialog`, GET /v1/legal/<doc>).
 * До этой ветки обе кнопки разворачивали один и тот же абзац-дисклеймер, который
 * к тому же уже был напечатан ниже, а самих документов не было нигде
 * (docs/tasks/Задача_feat_l10n-launch-surfaces.md §1/§B). Шторка, а не переход
 * на отдельный маршрут: `?invite=<token>` в адресе и выбранный язык гостя
 * должны остаться на месте.
 */
export function WelcomePage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const languageSwitcherProps = useLanguageSwitcherProps();
  const [searchParams] = useSearchParams();
  const inviteToken = searchParams.get('invite');
  const inviteQuery = useInvite(inviteToken);
  const authorizeUrl = useGoogleAuthorizeUrl();
  const [cookieChoice, setCookieChoiceState] = useState<CookieChoice | null>(() => getCookieChoice());
  // Показ ровно один раз (отсмотр 2026-08-24): решение «показывать ли» принимается
  // на монтировании и само фиксируется — без клика действует дефолт «только
  // необходимые», и при следующей загрузке баннер уже не возвращается.
  const [showCookieBanner] = useState<boolean>(() => !getCookieChoice() && !wasCookieBannerShown());
  useEffect(() => {
    if (showCookieBanner) markCookieBannerShown();
  }, [showCookieBanner]);
  const [openLegalDoc, setOpenLegalDoc] = useState<LegalDocSlug | null>(null);
  // «Аккаунт удалён» (ADR-169): человек пришёл сюда СРАЗУ после удаления —
  // без подтверждения экран входа выглядел бы как обычный выброс из сессии.
  // Флаг одноразовый (`take*` его же и стирает), читается на монтировании,
  // поэтому при следующем заходе на /welcome тоста не будет.
  const [accountDeleted, setAccountDeleted] = useState<boolean>(() => takeAccountDeletedNotice());
  useEffect(() => {
    if (!accountDeleted) return;
    const timer = setTimeout(() => setAccountDeleted(false), 6000);
    return () => clearTimeout(timer);
  }, [accountDeleted]);

  async function onGoogleClick(): Promise<void> {
    if (inviteToken && inviteQuery.data) {
      setPendingInvite({ token: inviteToken, contractId: inviteQuery.data.contractId });
    }
    const result = await authorizeUrl.mutateAsync();
    // Полный переход браузера, НЕ клиентский роутер (`navigate()`) — react-router
    // не умеет уходить на чужой origin (accounts.google.com), молча остаётся на
    // месте (docs/tasks/Задача_fix_web-google-redirect-external.md). В моке
    // `authorize_url` — внутренний роут (`/auth/google/mock`), `window.location.assign`
    // отрабатывает и для него — SPA-фолбэк (`try_files`/dev-сервер) отдаёт ту же страницу.
    window.location.assign(result.authorize_url);
  }

  // Второстепенный способ входа (ADR-168): почта. Приглашение запоминаем тем
  // же образом, что перед уходом в Google, — путь после входа общий.
  function onEmailClick(): void {
    if (inviteToken && inviteQuery.data) {
      setPendingInvite({ token: inviteToken, contractId: inviteQuery.data.contractId });
    }
    // Внутренний маршрут, клиентская навигация — никаких внешних переходов
    // (важно в PWA/TWA-обёртке).
    navigate('/login/email');
  }

  function onCookie(choice: CookieChoice): void {
    setCookieChoice(choice);
    setCookieChoiceState(choice);
  }

  return (
    <div className={styles.screen}>
      <aside className={styles.hero}>
        <div className={styles.heroGlow} />
        <span className="pr-eyebrow" style={{ color: 'var(--pr-amber-hi)' }}>
          {t('auth.welcomeEyebrow')}
        </span>
        {/* Знак на якорном экране (DEV-17 §3: вход/hero — место знака).
            Вспышка — в самом знаке, отдельная искра рядом не запускается. */}
        <Logo variant="mark" size={72} className={styles.heroMark} />
        <h1 className={styles.heroTitle}>{t('auth.welcomeTitle')}</h1>
        <p className={styles.heroText}>{t('auth.welcomeText')}</p>
      </aside>

      {/* Пока внизу висит cookie-баннер (position: fixed), панели нужен
          запас снизу: иначе на телефоне он накрывает оговорку и ссылки
          на документы, а прокрутить к ним нечего (отсмотр 2026-08-25). */}
      <main className={`${styles.panel} ${showCookieBanner && !cookieChoice ? styles.panelUnderBanner : ''}`}>
        <div className={styles.card}>
          <h2 className={styles.title}>{t('auth.welcomeEyebrow')}</h2>

          {inviteToken ? (
            inviteQuery.isPending ? (
              <Skeleton width="100%" height={72} radius="var(--pr-r-lg)" />
            ) : inviteQuery.data ? (
              <InviteBanner
                variant="valid"
                titleText={t('auth.inviteBannerTitle', { fromName: inviteQuery.data.fromName })}
                bodyText={t('auth.inviteBannerText', { contractTitle: inviteQuery.data.contractTitle })}
                actionLabel={t('auth.inviteBannerAction')}
                onAction={() => void onGoogleClick()}
                expiredText={t('auth.inviteBannerExpired')}
              />
            ) : (
              <InviteBanner
                variant="expired"
                actionLabel=""
                onAction={() => {}}
                expiredText={t('auth.inviteBannerExpired')}
              />
            )
          ) : null}

          <div className={styles.languageChipRow}>
            {/* DEV-16a §1/§6: chip — холодный вход (онбординг №12); globe — по инвайт-ссылке
                (та же точка, что «экран подписи по ссылке» — гость меняет язык до логина). */}
            <LanguageSwitcher variant={inviteToken ? 'globe' : 'chip'} {...languageSwitcherProps} />
          </div>
          {!inviteToken ? <p className={styles.tosText}>{t('locale.onboardingHint')}</p> : null}

          <GoogleButton label={t('auth.googleButton')} onClick={() => void onGoogleClick()} loading={authorizeUrl.isPending} />

          {/* Порядок намеренный: Google — главный вход, почта — второстепенный
              (ADR-168). Флаг выключен ⇒ кнопки нет, маршрут ведёт на /welcome. */}
          {EMAIL_LOGIN_ENABLED ? (
            <Button variant="outline" block onClick={onEmailClick}>
              {t('auth.emailButton')}
            </Button>
          ) : null}

          <div>
            <p className={styles.tosText}>{t('auth.tosAcceptText')}</p>
            <div className={styles.tosLinks}>
              <button type="button" className={styles.tosLink} onClick={() => setOpenLegalDoc('terms')}>
                {t('auth.tosLinkLabel')}
              </button>
              <button type="button" className={styles.tosLink} onClick={() => setOpenLegalDoc('privacy')}>
                {t('auth.privacyLinkLabel')}
              </button>
            </div>
          </div>

          {/* Дисклеймер о юрсиле — ОДИН раз. До этой ветки этот же текст мог
              оказаться на экране трижды: статикой здесь и ещё раз по каждой из
              двух кнопок (обе разворачивали его вместо документа). */}
          <p className={styles.disclaimer}>{t('auth.legalDisclaimerText')}</p>

          {/* Выход на публичный контур (ADR-195): человек, попавший сразу на
              экран входа — по прямой ссылке или из поисковой выдачи, — иначе
              не может ничего прочитать о продукте, не отдав Google-аккаунт.
              Обычная ссылка, а не `navigate`: публичные страницы пререндерены,
              и переход за пределы приложения здесь уместен.
              В установленном приложении ссылки нет: его первый экран — вход, и
              уводить человека в маркетинговые страницы внутри приложения из
              Play незачем (та же причина, по которой лендинг не показывается
              в обёртке). */}
          {!isAppWrapper() ? (
            <a className={styles.tosLink} href={publicPath(i18n.language, 'about')}>
              {t('help.aboutTitle')}
            </a>
          ) : null}
        </div>
      </main>

      <LegalDocumentDialog doc={openLegalDoc} onClose={() => setOpenLegalDoc(null)} />

      {accountDeleted ? <Toast text={t('profile.accDeleteDone')} /> : null}

      {showCookieBanner && !cookieChoice ? (
        <CookieBanner
          text={t('auth.cookieBannerText')}
          acceptAllLabel={t('auth.cookieBannerAcceptAll')}
          necessaryOnlyLabel={t('auth.cookieBannerNecessaryOnly')}
          onAcceptAll={() => onCookie('all')}
          onNecessaryOnly={() => onCookie('necessary')}
        />
      ) : null}
    </div>
  );
}

