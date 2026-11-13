import { useTranslation } from 'react-i18next';
import { Button } from '@porukam/ui';
import type { PushSubscribeResult } from './push';
import { failureReasonKey, PUSH_DEVICE_STATUS_KEY, type PushDeviceStatus } from './pushDeviceStatus';
import styles from './PushDeviceStatusRow.module.css';

export interface PushDeviceStatusRowProps {
  status: PushDeviceStatus;
  /** Последняя попытка подписки — из неё берётся причина и текст сбоя. */
  lastResult: PushSubscribeResult | null;
  /** Тумблер включён на сервере: тогда «не запрошено» — это разъезд, и его чинят кнопкой. */
  serverEnabled: boolean;
  onEnableHere: () => void;
  onRetry: () => void;
  retrying?: boolean;
}

/**
 * Строка «что с уведомлениями на ЭТОМ устройстве» под тумблером (ADR-175).
 *
 * До неё интерфейс отвечал только за намерение («push включён»), а доходят ли
 * уведомления сюда — не говорил вовсе: человек с включённым тумблером и нулём
 * подписок видел ровно то же, что человек с рабочей подпиской. Теперь состояние
 * названо словами, а два чинимых случая — разрешение не спрашивали здесь и
 * подписка не создалась — получили по кнопке.
 *
 * Третья кнопка — «Проверить сейчас» при уже рабочем состоянии (10.09) — не
 * украшение. Одно подключение устройства принадлежит ПОСЛЕДНЕМУ вошедшему
 * аккаунту (endpoint на бэке уникален), поэтому после смены аккаунта, смены
 * браузера по умолчанию или переустановки приложения строка честно говорит
 * «включены», а уведомления идут не туда. Раньше это чинил только выход и
 * повторный вход; теперь — эта кнопка: та же сверка, что при входе, но без
 * потери сессии.
 */
export function PushDeviceStatusRow({
  status,
  lastResult,
  serverEnabled,
  onEnableHere,
  onRetry,
  retrying,
}: PushDeviceStatusRowProps): JSX.Element | null {
  const { t } = useTranslation();
  if (status === 'loading') return null;

  const statusKey = PUSH_DEVICE_STATUS_KEY[status];
  if (!statusKey) return null;
  const text = status === 'failed' ? t(statusKey, { reason: t(failureReasonKey(lastResult)) }) : t(statusKey);
  // Текст исключения не переводится и переводу не подлежит: это то, что сказало
  // само устройство (жалоба «включил — не приходит» иначе не воспроизводится).
  const detail = status === 'failed' ? lastResult?.message : undefined;

  return (
    <div className={styles.row} data-testid="push-device-status">
      <p className={styles.text}>{text}</p>
      {detail ? (
        <p className={styles.detail} data-testid="push-device-detail">
          {detail}
        </p>
      ) : null}
      {status === 'not_asked' && serverEnabled ? (
        <Button variant="link" size="sm" onClick={onEnableHere} data-testid="push-enable-here">
          {t('notifications.pushDeviceEnableHere')}
        </Button>
      ) : null}
      {status === 'failed' ? (
        <Button variant="link" size="sm" onClick={onRetry} disabled={retrying} data-testid="push-retry">
          {t('notifications.pushDeviceRetry')}
        </Button>
      ) : null}
      {/* «Проверить сейчас» — см. пояснение в шапке файла. */}
      {status === 'enabled' ? (
        <Button variant="link" size="sm" onClick={onRetry} disabled={retrying} data-testid="push-recheck">
          {t('notifications.pushDeviceRecheck')}
        </Button>
      ) : null}
    </div>
  );
}
