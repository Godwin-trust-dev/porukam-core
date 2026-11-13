import { useTranslation } from 'react-i18next';
import { formatRelativeTime, type ChatThread } from '@porukam/core';
import { ListRow } from '@porukam/ui';
import { useOwnProfileSettings } from '../profile/api';
import { CounterpartyLink } from '../counterparty/CounterpartyLink';
import styles from './ChatThreadRow.module.css';

/**
 * Строка диалога (DEV-20 §5): лид — аватар собеседника, первая строка — он
 * сам и время последнего сообщения, вторая — сделка, к которой привязан
 * диалог, и начало последнего сообщения; непрочитанные — счётчиком справа.
 *
 * Имя собеседника резолвится публичным `GET /profiles/{id}` (тот же запрос,
 * что у строки договора) — в `ChatThread` его нет, есть только `profile_id`.
 */
export function ChatThreadRow({
  thread,
  selected,
  onOpen,
}: {
  thread: ChatThread;
  selected?: boolean;
  onOpen: () => void;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const profileQ = useOwnProfileSettings(thread.counterparty_profile_id);
  const name = profileQ.data ? (profileQ.data.display_name ?? t('reputation.nameHidden')) : '…';

  return (
    <ListRow
      data-testid="chat-thread-row"
      ariaLabel={thread.contract_title}
      avatarName={name}
      avatarSrc={profileQ.data?.avatar_url ?? undefined}
      title={
        <CounterpartyLink
          profileId={thread.counterparty_profile_id}
          name={profileQ.data ? (profileQ.data.display_name ?? null) : '…'}
          showHandle={false}
          plain
        />
      }
      /* Финал доска A: время — мелким приглушённым справа от имени. */
      titleAside={
        <span className={styles.time}>{formatRelativeTime(thread.last_message.created_at, Date.now(), i18n.language)}</span>
      }
      meta={
        <>
          {/* Отдельными узлами: сделка — самостоятельный смысл строки, по ней
              диалог и узнают (и по ней же её ищут глазами в списке). */}
          <span>{thread.contract_title}</span>
          {' · '}
          <span>{thread.last_message.body}</span>
        </>
      }
      /* Счётчик непрочитанного — янтарный кружок с тёмной цифрой (финал доска A). */
      metaAside={thread.unread_count > 0 ? <span className={styles.count}>{thread.unread_count}</span> : undefined}
      unread={thread.unread_count > 0}
      unreadAriaLabel={t('notifications.unreadAria')}
      selected={selected}
      onOpen={onOpen}
    />
  );
}
