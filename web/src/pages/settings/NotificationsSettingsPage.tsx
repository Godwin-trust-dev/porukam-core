import { useTranslation } from 'react-i18next';
import { Badge, Sheet, Button, SettingRow, Skeleton, Surface, IosInstallSheet } from '@porukam/ui';
import { usePushToggle } from '../../features/notifications/usePushToggle';
import { PushDeviceStatusRow } from '../../features/notifications/PushDeviceStatusRow';
import { useUpdateNotificationSettings } from '../../features/notifications/api';
import styles from './NotificationsSettingsPage.module.css';

/**
 * Настройки → уведомления (DEV-14 §6, ADR-057): лента «Всегда» — не тумблер, отключить
 * нельзя (центр событий); push/email — дубли; группы влияют только на push/email,
 * лента показывает всё всегда (§37a концепция). Push-тумблер + iOS-гейт — общий
 * `usePushToggle` (DEV-15 §5), тот же, что и в настройках «Приложение».
 */
export function NotificationsSettingsPage(): JSX.Element {
  const { t } = useTranslation();
  const push = usePushToggle();
  const update = useUpdateNotificationSettings();
  const settings = push.settings;

  if (push.isPending || !settings) {
    return (
      <div className={styles.wrap}>
        <Skeleton width="100%" height={64} />
        <Skeleton width="100%" height={64} />
        <Skeleton width="100%" height={64} />
      </div>
    );
  }

  const onLabel = t('notifications.toggleOn');
  const offLabel = t('notifications.toggleOff');

  return (
    <div className={styles.wrap}>
      <h3 className={styles.sectionTitle}>{t('notifications.channelsTitle')}</h3>

      {/* DEV-20 §5: канал/группа — строка на общей поверхности. */}
      <Surface>
      <SettingRow
        label={t('notifications.inAppLabel')}
        hint={t('notifications.inAppHint')}
        control="static"
        staticValue={<Badge tone="teal">{t('notifications.inAppAlways')}</Badge>}
      />

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
        toggleOnLabel={onLabel}
        toggleOffLabel={offLabel}
      />

      {/* Что с уведомлениями на ЭТОМ устройстве (ADR-175): серверный тумблер
          говорит о намерении, а дойдёт ли push сюда — только устройство. */}
      <PushDeviceStatusRow
        status={push.deviceStatus}
        lastResult={push.lastSubscribeResult}
        serverEnabled={push.checked}
        onEnableHere={push.enableOnThisDevice}
        onRetry={() => void push.retrySubscribe()}
        retrying={push.retrying}
      />

      <SettingRow
        label={t('notifications.emailLabel')}
        // У OTP-пользователя email_address пуст — фраза «Дублировать
        // уведомления на » обрывалась (qa-backlog 2026-08-20 §2).
        hint={settings.email_address ? t('notifications.emailHint', { email: settings.email_address }) : t('notifications.emailHintNoAddress')}
        control="toggle"
        checked={settings.email}
        onToggle={(v) => update.mutate({ email: v })}
        toggleOnLabel={onLabel}
        toggleOffLabel={offLabel}
      />
      </Surface>

      <h3 className={styles.sectionTitle}>{t('notifications.groupsTitle')}</h3>
      <p className={styles.groupsHint}>{t('notifications.groupsHint')}</p>

      <Surface>
      <SettingRow
        label={t('notifications.groupDeals')}
        help={t('hints.settings.notif.deals')}
        helpLabel={t('hints.helpButton')}
        control="toggle"
        checked={settings.groups.deals}
        onToggle={(v) => update.mutate({ groups: { ...settings.groups, deals: v } })}
        toggleOnLabel={onLabel}
        toggleOffLabel={offLabel}
      />
      <SettingRow
        label={t('notifications.groupChats')}
        help={t('hints.settings.notif.chats')}
        helpLabel={t('hints.helpButton')}
        control="toggle"
        checked={settings.groups.chats}
        onToggle={(v) => update.mutate({ groups: { ...settings.groups, chats: v } })}
        toggleOnLabel={onLabel}
        toggleOffLabel={offLabel}
      />
      <SettingRow
        label={t('notifications.groupPayments')}
        help={t('hints.settings.notif.payments')}
        helpLabel={t('hints.helpButton')}
        control="toggle"
        checked={settings.groups.payments}
        onToggle={(v) => update.mutate({ groups: { ...settings.groups, payments: v } })}
        toggleOnLabel={onLabel}
        toggleOffLabel={offLabel}
      />
      <SettingRow
        label={t('notifications.groupDeadlines')}
        help={t('hints.settings.notif.deadlines')}
        helpLabel={t('hints.helpButton')}
        control="toggle"
        checked={settings.groups.deadlines}
        onToggle={(v) => update.mutate({ groups: { ...settings.groups, deadlines: v } })}
        toggleOnLabel={onLabel}
        toggleOffLabel={offLabel}
      />
      <SettingRow
        label={t('notifications.groupDisputes')}
        help={t('hints.settings.notif.disputes')}
        helpLabel={t('hints.helpButton')}
        control="toggle"
        checked={settings.groups.disputes}
        onToggle={(v) => update.mutate({ groups: { ...settings.groups, disputes: v } })}
        toggleOnLabel={onLabel}
        toggleOffLabel={offLabel}
      />
      </Surface>

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
