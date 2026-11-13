import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Icon, Logo, WorkArea, type IconName } from '@porukam/ui';
import { isFeatureEnabled, type FeatureKey } from '../shared/features';
import { ActorSwitcher } from '../features/actor/ActorSwitcher';
import { useChatUnreadCount } from '../features/chat/api';
import { useNotificationsUnreadCount } from '../features/notifications/api';
import { useNativePushRegister } from '../features/notifications/useNativePushRegister';
import { usePushResubscribe } from '../features/notifications/usePushResubscribe';
import { PwaSurfaces } from '../features/pwa/PwaSurfaces';
import { SectionMenu } from '../features/shell/SectionMenu';
import { ShellHeaderHost } from '../features/shell/shellHeader';
import styles from './ShellLayout.module.css';

interface NavEntry {
  to: string;
  labelKey: string;
  icon: IconName;
  /**
   * Источник счётчика для бейджа непрочитанного (отсмотр 2026-08-24 —
   * «значок как в мессенджерах»): notifications — непрочитанные уведомления,
   * chat — диалоги с непрочитанными сообщениями. Новому разделу с «новым»
   * (этапы и т.п.) — добавлять сюда свой источник, не второй механизм.
   */
  badge?: 'notifications' | 'chat';
  /** Раздел за фич-флагом (web/src/shared/features.ts) — без флага в навигации не показывается. */
  feature?: FeatureKey;
  /** Короткая подпись для нижней навигации (финал доска A: «Уведомл.»), если полная не влезает. */
  shortLabelKey?: string;
}

// Desktop сайдбар (§7.2)
const visible = (e: NavEntry): boolean => !e.feature || isFeatureEnabled(e.feature);

// «Лента» (/feed) заменена «Главной» (`/`, рабочий стол): /feed — редирект на
// /notifications (router.tsx), два пункта в один адрес путали бы навигацию,
// а у рабочего стола до этого вовсе не было пункта (только клик по логотипу).
const SIDEBAR: NavEntry[] = ([
  { to: '/', labelKey: 'nav.home', icon: 'home' },
  // Поиск в десктоп-сайдбаре (отсмотр 12.09: «в десктопной версии поиск
  // вообще не вынесен в общем меню слева»): раньше жил только в мобильном
  // bottom-nav, и с появлением каталога исполнителей (план 11.09 §5–7) стал
  // одним из главных разделов — на десктопе до него было не добраться.
  { to: '/search', labelKey: 'nav.search', icon: 'search', feature: 'search' },
  { to: '/notifications', labelKey: 'nav.notifications', icon: 'bell', badge: 'notifications' },
  // Чат в десктоп-сайдбаре (отсмотр 2026-08-24: «чаты вынести на боковую
  // панель») — раньше жил только в мобильном bottom-nav.
  { to: '/chat', labelKey: 'nav.chat', icon: 'chat', badge: 'chat', feature: 'chat' },
  { to: '/contracts', labelKey: 'nav.deals', icon: 'deals' },
  { to: '/stages', labelKey: 'nav.stages', icon: 'stages' },
  { to: '/payments', labelKey: 'nav.payments', icon: 'wallet' },
  { to: '/disputes', labelKey: 'nav.disputes', icon: 'dispute' },
  { to: '/reputation', labelKey: 'nav.reputation', icon: 'reputation' },
  { to: '/me', labelKey: 'nav.profile', icon: 'profile' },
  { to: '/groups', labelKey: 'nav.groups', icon: 'share', feature: 'groups' },
] satisfies NavEntry[]).filter(visible);

// Нижний блок сайдбара (отсмотр 12.09: «вынесем ссылку на Что такое Porukam,
// самой нижней её поставим»). Отдельно от SIDEBAR: это не раздел приложения, а
// справка, и она прижата к низу панели (.navItemBottom → margin-top: auto).
// Подпись берём готовым ключом `profile.linkAbout` — тот же текст уже переведён
// на все 29 локалей для той же ссылки в профиле, второй ключ с тем же смыслом
// заводить незачем.
const SIDEBAR_FOOTER: NavEntry[] = [
  { to: '/help/about', labelKey: 'profile.linkAbout', icon: 'info' },
];

// Mobile bottom-nav (§7.1)
const BOTTOM: NavEntry[] = ([
  { to: '/', labelKey: 'nav.home', icon: 'home' },
  { to: '/search', labelKey: 'nav.search', icon: 'search', feature: 'search' },
  { to: '/contracts', labelKey: 'nav.deals', icon: 'deals' },
  { to: '/notifications', labelKey: 'nav.notifications', shortLabelKey: 'nav.notificationsShort', icon: 'bell', badge: 'notifications' },
  { to: '/chat', labelKey: 'nav.chat', icon: 'chat', badge: 'chat', feature: 'chat' },
  { to: '/me', labelKey: 'nav.profile', icon: 'profile' },
] satisfies NavEntry[]).filter(visible);

export function ShellLayout(): JSX.Element {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const unreadNotifications = useNotificationsUnreadCount();
  const unreadChats = useChatUnreadCount();
  // Сверка Web Push подписки при входе (ADR-110): тумблер включён, а подписки
  // в браузере/на бэке может не быть — чинится тут, без системного запроса.
  usePushResubscribe();
  // Нативный канал обёртки (ADR-176): токен провайдера приезжает в стартовом
  // URL до входа, а закрепить его за аккаунтом можно только после — здесь.
  useNativePushRegister();
  const badgeCount = (e: NavEntry): number =>
    e.badge === 'notifications' ? unreadNotifications : e.badge === 'chat' ? unreadChats : 0;
  // `/` матчится только точно — иначе «Главная» перехватывала бы любой путь.
  const current = [...SIDEBAR, ...SIDEBAR_FOOTER, ...BOTTOM].find((e) =>
    e.to === '/' ? pathname === '/' : pathname.startsWith(e.to),
  );
  const title = current ? t(current.labelKey) : t('common.appName');
  // Мобильное меню разделов = сайдбар десктопа + «Поиск» (он живёт только в
  // bottom-nav) — полный перечень, которого на телефоне не было.
  const menuEntries = [...SIDEBAR, ...BOTTOM.filter((b) => !SIDEBAR.some((s) => s.to === b.to))];
  const menuItems = menuEntries.map((e) => ({
    to: e.to,
    label: t(e.labelKey),
    icon: e.icon,
    badge: badgeCount(e),
    active: e === current,
  }));

  return (
    <div className={styles.shell}>
      <nav className={styles.sidebar} aria-label={t('common.appName')}>
        {/* Бренд-блок — ссылка на главную (отсмотр 2026-08-18 №3/№7). Знак и
            словознак — компонент Logo (DEV-17 §3): словознак одним цветом,
            на тёмном сайдбаре — крем. Имя ссылке даёт словознак. */}
        <NavLink to="/" className={styles.brand} data-testid="brand-home">
          <Logo variant="full" on="dark" size={30} wordmark={t('common.appName')} />
        </NavLink>
        {SIDEBAR.map((e) => (
          <NavLink
            key={e.to}
            to={e.to}
            end={e.to === '/'}
            className={({ isActive }) => `${styles.navItem} ${isActive ? styles.navItemActive : ''}`}
          >
            <Icon name={e.icon} size={24} />
            {t(e.labelKey)}
            {badgeCount(e) > 0 ? (
              <span className={styles.navBadge} aria-live="polite">
                {badgeCount(e) > 99 ? '99+' : badgeCount(e)}
              </span>
            ) : null}
          </NavLink>
        ))}
        {SIDEBAR_FOOTER.map((e) => (
          <NavLink
            key={e.to}
            to={e.to}
            className={({ isActive }) =>
              `${styles.navItem} ${styles.navItemBottom} ${isActive ? styles.navItemActive : ''}`
            }
          >
            <Icon name={e.icon} size={24} />
            {t(e.labelKey)}
          </NavLink>
        ))}
      </nav>

      <div className={styles.main}>
        {/* Финал доска A: на телефоне шапка принадлежит экрану — он может
            занять заголовок («‹ Настройки») и правый край («Прочитать все»,
            «+») порталом (`useShellHeader`); пока не занял — меню разделов
            и переключатель актёра. Провайдер оборачивает и контент. */}
        <ShellHeaderHost
          renderHeader={(slots) => (
            <header className={styles.header}>
              <WorkArea className={styles.headerInner}>{slots}</WorkArea>
            </header>
          )}
          titleClassName={styles.headerSlotTitle}
          actionsClassName={styles.headerSlotActions}
          menu={
            <>
              <h1 className={styles.pageTitle}>{title}</h1>
              <SectionMenu title={title} label={t('shell.sectionMenu')} items={menuItems} />
            </>
          }
          actor={<ActorSwitcher />}
        >
          <PwaSurfaces />

          <main className={styles.content}>
            {/* DEV-19 §1: рабочая область — центрированный контейнер
                --pr-work-max. Собственных max-width страницы не держат. */}
            <WorkArea>
              <Outlet />
            </WorkArea>
          </main>
        </ShellHeaderHost>

        <nav className={styles.bottomNav} aria-label={t('common.appName')}>
          {BOTTOM.map((e) => (
            <NavLink key={e.to} to={e.to} end={e.to === '/'} className={({ isActive }) => `${styles.tab} ${isActive ? styles.tabActive : ''}`}>
              <span className={styles.tabIconWrap}>
                <Icon name={e.icon} size={24} />
                {badgeCount(e) > 0 ? (
                  <span className={styles.navBadge} aria-live="polite">
                    {badgeCount(e) > 99 ? '99+' : badgeCount(e)}
                  </span>
                ) : null}
              </span>
              <span className={styles.tabLabel}>{t(e.shortLabelKey ?? e.labelKey)}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}
