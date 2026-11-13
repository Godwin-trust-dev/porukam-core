import { useTranslation } from 'react-i18next';
import type { Notification } from '@porukam/core';
import { Badge, Button, Icon, LtrText, type IconName } from '@porukam/ui';
import { useFormatters } from '../../shared/formatters';
import { CounterpartyLink } from '../counterparty/CounterpartyLink';
import styles from './NotificationDetailPane.module.css';

export interface NotificationDetailPaneProps {
  notification: Notification;
  /** Иконка по типу события — карта живёт на странице (единая со списком). */
  icon: IconName;
  /** Открыть место события: то же действие, что тап по пункту ленты. */
  onOpen: () => void;
  /** Открыть карточку договора, если событие про сделку. */
}

/**
 * Детали уведомления в колонке master-detail (DEV-19 §2). Данные — из уже
 * загруженной ленты: второго запроса за тем же событием нет, и «прочитано»
 * ставится там же, где раньше, — при открытии пункта.
 */
export function NotificationDetailPane({
  notification: n,
  icon,
  onOpen,
}: NotificationDetailPaneProps): JSX.Element {
  const { t } = useTranslation();
  const { formatDateTime, formatMoney } = useFormatters();

  // Та же семантика severity, что в пункте ленты (DEV-14 §3): due — тёплая,
  // good — зелёная, normal — нейтральная. Смысл дублируется текстом, не только цветом.
  const glyphTone = n.severity === 'due' ? styles.glyphDue : n.severity === 'good' ? styles.glyphGood : '';

  return (
    <section className={styles.pane} data-testid="notification-detail-pane" data-notification-id={n.id}>
      <div className={styles.top}>
        <span className={`${styles.glyph} ${glyphTone}`} aria-hidden="true">
          <Icon name={icon} size={24} />
        </span>
        <LtrText as="span" className={styles.time}>
          {formatDateTime(n.created_at)}
        </LtrText>
        {!n.read ? <Badge tone="amber">{t('notifications.unreadAria')}</Badge> : null}
      </div>

      <h3 className={styles.title}>{n.title}</h3>

      {n.counterparty || n.contract || n.amount ? (
        <dl className={styles.rows}>
          {n.counterparty ? (
            <div className={styles.row}>
              <dt className={styles.rowLabel}>{t('contract.parties')}</dt>
              {/* Бэклог 2026-08-21: контрагент — ссылка на карточку + копирование хендла. */}
              <dd className={styles.rowValue}>
                <CounterpartyLink
                  profileId={n.counterparty.profile_id}
                  name={n.counterparty.name}
                  showAvatar
                  data-testid="notification-counterparty"
                />
              </dd>
            </div>
          ) : null}
          {n.contract?.number ? (
            <div className={styles.row}>
              <dt className={styles.rowLabel}>{t('contracts.title')}</dt>
              <dd className={styles.rowValue}>
                <LtrText as="span">{t('notifications.contractNo', { number: n.contract.number })}</LtrText>
              </dd>
            </div>
          ) : null}
          {n.amount ? (
            <div className={styles.row}>
              <dt className={styles.rowLabel}>{t('contract.total')}</dt>
              <dd className={styles.rowValue}>
                <LtrText as="span">{formatMoney(n.amount)}</LtrText>
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      <div className={styles.actions}>
        {/* Отсмотр 2026-08-21: одна кнопка «Открыть» для всех уведомлений.
            Бэк отдаёт action.label="" (selectors.py), `??` пустую строку не
            ловит — поэтому `||`. «Полная карточка» убрана: действие ведёт туда же. */}
        <Button variant="primary" onClick={onOpen} data-testid="notification-pane-open">
          {n.action?.label || t('contracts.actionOpen')}
        </Button>
      </div>
    </section>
  );
}
