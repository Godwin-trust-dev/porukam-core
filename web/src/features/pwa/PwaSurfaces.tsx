import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { InstallBanner, IosInstallSheet, NetworkBanner, UpdateToast } from '@porukam/ui';
import { trackInstallEvent } from '../analytics/installEvents';
import { useInstall } from './useInstall';
import { ManualInstallSheet } from './ManualInstallSheet';
import { useNetworkStatus } from './useNetworkStatus';
import { useSwUpdate } from './useSwUpdate';
import styles from './PwaSurfaces.module.css';

/**
 * Оркестратор PWA-поверхностей (DEV-15): монтируется один раз в `ShellLayout`, не в каждой
 * странице. Install-баннер — «не на загрузке» (§2): за неимением доменного флага вроде
 * «первое подписание» показываем его после первой смены маршрута внутри приложения — того
 * достаточно, чтобы не бить по глазам в первую секунду входа [Ф-решение].
 */
export function PwaSurfaces(): JSX.Element {
  const { t } = useTranslation();
  const location = useLocation();
  const install = useInstall();
  const online = useNetworkStatus();
  const swUpdate = useSwUpdate();
  const [iosSheetOpen, setIosSheetOpen] = useState(false);
  const [manualSheetOpen, setManualSheetOpen] = useState(false);

  const firstPath = useRef(location.pathname);
  const [navigatedOnce, setNavigatedOnce] = useState(false);
  useEffect(() => {
    if (location.pathname !== firstPath.current) setNavigatedOnce(true);
  }, [location.pathname]);

  // Баннер показываем всем, кто ещё не поставил приложение, — в том числе там, где браузер
  // не дал `beforeinstallprompt` (`needsManualHowTo`). Раньше условие требовало системного
  // промпта либо iOS, и на Samsung Internet предложение установки не появлялось вовсе
  // (жалоба владельца 05.09: «на мобильном не предлагает скачать приложение»).
  const showInstall =
    navigatedOnce &&
    !install.dismissed &&
    !install.isStandalone &&
    (install.canInstall || install.isIos || install.needsManualHowTo);

  // Показ предложения — верхняя ступень воронки установки (ADR-171). Ref, а не
  // state: событие отправляется ОДИН раз за монтирование, и перерисовывать
  // из-за него оболочку незачем. Без этой ступени «поставили / не поставили»
  // не с чем сравнивать — непонятно, предлагали ли вообще.
  const promptReported = useRef(false);
  useEffect(() => {
    if (showInstall && !promptReported.current) {
      promptReported.current = true;
      trackInstallEvent('install_prompt_shown');
    }
  }, [showInstall]);

  function onInstallClick(): void {
    // Клик считаем ДО развилки: нажатие одно, а исходов три (системный
    // промпт, инструкция iOS, шторка «руками») — и в воронке они одно и то же.
    trackInstallEvent('install_click');
    if (install.isIos) setIosSheetOpen(true);
    else if (install.canInstall) void install.promptInstall();
    // Системного промпта нет — вместо молчания показываем путь через меню браузера.
    else setManualSheetOpen(true);
  }

  return (
    <>
      {!online ? <NetworkBanner text={t('pwa.networkOfflineCachedText')} /> : null}

      {showInstall ? (
        <div className={styles.installSlot}>
          <InstallBanner
            titleLabel={t('pwa.installBannerTitle')}
            installLabel={t('pwa.installBannerCta')}
            dismissAriaLabel={t('pwa.installBannerDismissAria')}
            onInstall={onInstallClick}
            onDismiss={install.dismiss}
          />
        </div>
      ) : null}

      <ManualInstallSheet open={manualSheetOpen} onClose={() => setManualSheetOpen(false)} />

      <IosInstallSheet
        open={iosSheetOpen}
        onClose={() => setIosSheetOpen(false)}
        titleLabel={t('pwa.iosSheetTitle')}
        step1Label={t('pwa.iosSheetStep1')}
        step2Label={t('pwa.iosSheetStep2')}
        step3Label={t('pwa.iosSheetStep3')}
        pushHintLabel={t('pwa.iosSheetPushHint')}
        closeLabel={t('pwa.iosSheetClose')}
      />

      {swUpdate.visible ? (
        <UpdateToast
          text={t('pwa.updateToastText')}
          updateLabel={t('pwa.updateToastCta')}
          dismissAriaLabel={t('pwa.updateToastDismissAria')}
          onUpdate={swUpdate.update}
          onDismiss={swUpdate.dismiss}
        />
      ) : null}
    </>
  );
}
