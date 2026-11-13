import { useTranslation } from 'react-i18next';
import { Badge, Button, Callout, IosInstallSheet, LanguageSwitcher, Sheet, SettingRow, Skeleton, Surface } from '@porukam/ui';
import { useState } from 'react';
import { useInstall } from '../../features/pwa/useInstall';
import { DefaultBrowserHint } from '../../features/pwa/DefaultBrowserHint';
import { ManualInstallSheet } from '../../features/pwa/ManualInstallSheet';
import { useSwUpdate } from '../../features/pwa/useSwUpdate';
import { usePushToggle } from '../../features/notifications/usePushToggle';
import { PushDeviceStatusRow } from '../../features/notifications/PushDeviceStatusRow';
import { PushDebugPanel } from '../../features/notifications/PushDebugPanel';
import { useLanguageSwitcherProps } from '../../features/locale/useLanguageSwitcherProps';
import styles from './AppSettingsPage.module.css';

/**
 * Настройки → «Приложение» (DEV-15 §6): установка на экран, push (переиспользует
 * `usePushToggle` — тот же тумблер, что и в «Уведомления», DEV-14 §6), версия/обновление.
 */
export function AppSettingsPage(): JSX.Element {
  const { t } = useTranslation();
  const install = useInstall();
  const swUpdate = useSwUpdate();
  const push = usePushToggle();
  const [iosInstallOpen, setIosInstallOpen] = useState(false);
  const [manualInstallOpen, setManualInstallOpen] = useState(false);
  const languageSwitcherProps = useLanguageSwitcherProps();
  // `?debug=push` — панель сырых фактов об уведомлениях на устройстве (жалоба 10.09:
  // подписка на бэке создаётся, а разрешение здесь читается как «не запрошено»).
  // Читаем адрес напрямую, а не `useSearchParams`: страница рендерится и вне роутера
  // (её собственные тесты), и падать из-за диагностики она не должна.
  const [debugPush] = useState(() => new URLSearchParams(window.location.search).get('debug') === 'push');

  function onInstallClick(): void {
    if (install.isIos) {
      setIosInstallOpen(true);
      return;
    }
    // Системный промпт установки бывает только там, где браузер отдал `beforeinstallprompt`.
    // На Android его может не быть вовсе (Firefox, Samsung Internet; Chrome не шлёт событие
    // повторно после отказа и до истечения своего таймаута) — раньше строка в этом случае
    // молча не делала НИЧЕГО, и человек решал, что установка сломана (жалоба владельца 05.09
    // «не предлагает скачать приложение»). Показываем ручной путь через меню браузера.
    if (!install.canInstall) {
      setManualInstallOpen(true);
      return;
    }
    void install.promptInstall();
  }

  return (
    <div className={styles.wrap}>
      {/* Приложение открыто не в Chrome (10.09): выбрать браузер за человека
          нельзя — это системная настройка, поэтому объясняем и ведём в неё. */}
      <DefaultBrowserHint />

      {/* DEV-16a §6 / DEV-16b §0 — «Язык и регион»: только язык интерфейса, официальный язык договора выбирается отдельно — поясняем прямо под строкой (термин «канон» в UI не звучит). */}
      <LanguageSwitcher variant="row" {...languageSwitcherProps} />
      <Callout tone="neutral">{t('locale.settingsLanguageExplain')}</Callout>

      {/* DEV-20 §5: установка/пуш/версия — строки одной поверхности. */}
      <Surface>
      {install.isStandalone ? (
        <SettingRow
          label={t('pwa.settingsInstallLabel')}
          control="static"
          staticValue={<Badge tone="teal">{t('pwa.settingsInstalledBadge')}</Badge>}
        />
      ) : (
        <SettingRow
          label={t('pwa.settingsInstallLabel')}
          hint={t('pwa.settingsInstallHint')}
          control="link"
          onLinkClick={onInstallClick}
        />
      )}

      {push.isPending || !push.settings ? (
        <Skeleton width="100%" height={64} />
      ) : (
        <>
          <SettingRow
            label={t('notifications.push_enable')}
            hint={
              push.pushDenied
                ? t('notifications.pushDeniedHint')
                : push.needsIosGate
                  ? t('pwa.iosPushGateHint')
                  : t('notifications.pushHint')
            }
            control="toggle"
            checked={push.checked}
            disabled={push.pushDenied}
            onToggle={push.onToggle}
            toggleOnLabel={t('notifications.toggleOn')}
            toggleOffLabel={t('notifications.toggleOff')}
          />
          {/* Та же строка состояния устройства, что в «Уведомлениях» (ADR-175):
              обе поверхности показывают push, значит обе обязаны честно
              говорить, дойдёт ли он на это устройство. */}
          <PushDeviceStatusRow
            status={push.deviceStatus}
            lastResult={push.lastSubscribeResult}
            serverEnabled={push.checked}
            onEnableHere={push.enableOnThisDevice}
            onRetry={() => void push.retrySubscribe()}
            retrying={push.retrying}
          />
        </>
      )}

      <SettingRow
        label={t('pwa.settingsVersionLabel')}
        control="static"
        staticValue={
          <span className={styles.version}>
            <span className={styles.versionNumber}>{__APP_VERSION__}</span>
            {swUpdate.visible ? (
              <Badge tone="amber">{t('pwa.settingsVersionUpdateAvailable')}</Badge>
            ) : (
              <span className={styles.versionOk}>{t('pwa.settingsVersionCurrent')}</span>
            )}
          </span>
        }
      />
      </Surface>

      {debugPush ? <PushDebugPanel /> : null}

      <ManualInstallSheet open={manualInstallOpen} onClose={() => setManualInstallOpen(false)} />

      <IosInstallSheet
        open={iosInstallOpen}
        onClose={() => setIosInstallOpen(false)}
        titleLabel={t('pwa.iosSheetTitle')}
        step1Label={t('pwa.iosSheetStep1')}
        step2Label={t('pwa.iosSheetStep2')}
        step3Label={t('pwa.iosSheetStep3')}
        pushHintLabel={t('pwa.iosSheetPushHint')}
        closeLabel={t('pwa.iosSheetClose')}
      />

      <Sheet
        open={push.sheetOpen}
        title={t('notifications.pushSheetTitle')}
        onClose={() => push.setSheetOpen(false)}
        closeLabel={t('common.close')}
        actions={
          <>
            <Button variant="ghost" onClick={() => push.setSheetOpen(false)}>
              {t('notifications.pushSheetNotNow')}
            </Button>
            <Button variant="primary" onClick={() => void push.confirm()}>
              {t('notifications.pushSheetAllow')}
            </Button>
          </>
        }
      >
        <p>{t('notifications.push_permission_prompt')}</p>
      </Sheet>

      <IosInstallSheet
        open={push.iosGateOpen}
        onClose={() => push.setIosGateOpen(false)}
        titleLabel={t('pwa.iosSheetTitle')}
        step1Label={t('pwa.iosSheetStep1')}
        step2Label={t('pwa.iosSheetStep2')}
        step3Label={t('pwa.iosSheetStep3')}
        pushHintLabel={t('pwa.iosSheetPushHint')}
        closeLabel={t('pwa.iosSheetClose')}
      />
    </div>
  );
}
