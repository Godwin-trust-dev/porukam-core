import { useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Icon, SettingsNav } from '@porukam/ui';
import { useActorStore } from '../../features/actor/actorStore';
import { useShellHeader } from '../../features/shell/shellHeader';
import { SETTINGS_SECTION_KEYS as SECTION_KEYS, GROUP_SECTION } from './sections';
import styles from './SettingsLayout.module.css';

/**
 * Оболочка настроек (DEV-02 §5, §8): desktop — липкий `SettingsNav` слева + контент
 * справа; mobile — заголовок раздела с «назад» в хаб и компактный переключатель разделов.
 */
export function SettingsLayout(): JSX.Element {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const activeGroupId = useActorStore((s) => s.activeGroupId);

  // Настройки объединения — раздел АКТИВНОГО актёра (ADR-129), поэтому он
  // появляется первым и только когда в шапке выбрано объединение.
  const keys: string[] = activeGroupId ? [GROUP_SECTION, ...SECTION_KEYS] : [...SECTION_KEYS];
  const items = keys.map((key) => ({ key, label: t(`profile.nav${capitalize(key)}`) }));
  // `includes`, а не `endsWith`: на вложенном /me/settings/account/delete
  // подсвечивался «Профиль» — первый ключ по умолчанию (отсмотр 2026-08-25).
  const active = keys.find((key) => pathname === `/me/settings/${key}` || pathname.startsWith(`/me/settings/${key}/`)) ?? keys[0] ?? 'profile';
  const activeLabel = items.find((i) => i.key === active)?.label ?? '';
  /** Хаб — сам `/me/settings` без раздела: на узком экране там список разделов. */
  const isHub = pathname === '/me/settings' || pathname === '/me/settings/';

  // Ушли из контекста объединения, стоя в его настройках, — там больше нечего
  // показывать: уводим в профиль, а не оставляем пустой раздел без пункта меню.
  const onGroupSection = pathname.endsWith(`/${GROUP_SECTION}`);
  useEffect(() => {
    if (onGroupSection && !activeGroupId) navigate('/me/settings/profile', { replace: true });
  }, [onGroupSection, activeGroupId, navigate]);

  // На узком экране разделы — это drill-in из хаба (`SettingsHubPage`),
  // поэтому «назад» ведёт К СПИСКУ разделов, а в профиль — только с
  // самого хаба. Финал доска A: «‹ Настройки» стоит В ШАПКЕ ОБОЛОЧКИ вместо
  // меню разделов (порталом), а не второй полосой под ней. Без оболочки
  // (изолированный рендер) шапка рисуется здесь же. На десктопе — рейл слева.
  const mobileHeader = (
    <>
      <button
        type="button"
        className={styles.backBtn}
        onClick={() => navigate(isHub ? '/me' : '/me/settings')}
        aria-label={t('common.back')}
      >
        <Icon name="back" size={20} directional />
      </button>
      <h1 className={styles.mobileTitle}>{isHub ? t('profile.settingsTitle') : activeLabel}</h1>
    </>
  );
  const shell = useShellHeader({ title: mobileHeader });

  return (
    <div className={styles.wrap}>
      {shell.portal}
      {shell.inShell ? null : <div className={styles.mobileHeader}>{mobileHeader}</div>}

      <div className={styles.body}>
        <div className={styles.rail}>
          <h1 className={styles.railTitle}>{t('profile.settingsTitle')}</h1>
          <SettingsNav
            items={items}
            active={active}
            onSelect={(key) => navigate(`/me/settings/${key}`)}
            ariaLabel={t('profile.settingsTitle')}
          />
        </div>
        <div className={styles.content}>
          <Outlet />
        </div>
      </div>
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
