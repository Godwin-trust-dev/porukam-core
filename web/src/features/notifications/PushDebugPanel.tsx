import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@porukam/ui';
import { useNotificationSettings } from './api';
import { collectPushDebug, formatPushDebug, type PushDebugEntry } from './pushDebug';
import { usePushDeviceStore } from './pushDeviceStore';
import type { PushSubscribeResult } from './push';
import styles from './PushDebugPanel.module.css';

/** Последняя попытка подписки в этой вкладке — машинная причина, не человеческая формулировка. */
function formatLastResult(result: PushSubscribeResult | null): string {
  if (!result) return 'none';
  const parts = [`ok=${String(result.ok)}`];
  if (result.reason) parts.push(`reason=${result.reason}`);
  if (result.message) parts.push(`message=${result.message}`);
  return parts.join(' ');
}

/**
 * Панель диагностики Web Push (жалоба владельца 10.09). Показывается ТОЛЬКО по
 * `?debug=push` — это не функция продукта, а способ получить сырые факты с чужого
 * телефона, где devtools недоступны: подписка на бэке создаётся (`POST
 * /v1/push-subscriptions -> 201`), а `Notification.permission` в том же браузере
 * читается как `default`, и без снимка устройства эти два факта не примиряются.
 *
 * Панель только читает. Ни `subscribe`, ни `unsubscribe`, ни системный запрос
 * разрешения отсюда не вызываются: снимок обязан описывать состояние ДО себя, иначе
 * он лечит симптом и уничтожает улику (и заодно нарушил бы §5 «мягкий момент» —
 * системный диалог показывается только по явному действию человека).
 *
 * Ключи снимка не переводятся: `Notification.permission`, `granted`, `activated` —
 * идентификаторы браузерных API, которые сверяют со спецификацией и логами nginx.
 * Переводятся только заголовок и подписи кнопок — то, по чему владелец находит панель.
 */
export function PushDebugPanel(): JSX.Element {
  const { t } = useTranslation();
  const { data: settings } = useNotificationSettings();
  const lastResult = usePushDeviceStore((s) => s.lastSubscribeResult);
  const [device, setDevice] = useState<PushDebugEntry[]>([]);
  const [nonce, setNonce] = useState(0);
  // Клипборд в TWA и в вебвью бывает недоступен вовсе — тогда текст показывается
  // для ручного выделения, иначе кнопка «Скопировать» молча не делала бы ничего.
  const [manualCopy, setManualCopy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void collectPushDebug().then((rows) => {
      if (!cancelled) setDevice(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const rows: PushDebugEntry[] = [
    ...device,
    { key: 'lastSubscribeResult', value: formatLastResult(lastResult) },
    { key: 'settings.push', value: settings ? String(settings.push) : 'unknown' },
    { key: 'settings.push_permission', value: settings ? String(settings.push_permission) : 'unknown' },
  ];
  const text = formatPushDebug(rows);

  async function onCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setManualCopy(false);
    } catch {
      setManualCopy(true);
    }
  }

  return (
    <section className={styles.panel} data-testid="push-debug-panel">
      <h2 className={styles.title}>{t('notifications.pushDebugTitle')}</h2>
      <dl className={styles.list}>
        {rows.map((row) => (
          <div className={styles.row} key={row.key}>
            <dt className={styles.key}>{row.key}</dt>
            <dd className={styles.value} data-testid={`push-debug-${row.key}`}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
      <div className={styles.actions}>
        <Button variant="ghost" size="sm" onClick={() => setNonce((n) => n + 1)} data-testid="push-debug-refresh">
          {t('notifications.pushDebugRefresh')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void onCopy()} data-testid="push-debug-copy">
          {t('notifications.pushDebugCopy')}
        </Button>
      </div>
      {manualCopy ? (
        <>
          <p className={styles.hint}>{t('notifications.pushDebugCopyManual')}</p>
          <textarea className={styles.fallback} readOnly value={text} rows={12} data-testid="push-debug-textarea" />
        </>
      ) : null}
    </section>
  );
}
