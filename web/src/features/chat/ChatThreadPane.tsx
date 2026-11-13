import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, formatDateTime, type RealTimelineEvent } from '@porukam/core';
import { Button, ChatBubble, ChatComposer, ChatLog, ChatSystemEvent, ErrorState, Icon, Skeleton } from '@porukam/ui';
import { useCurrentUser } from '../auth/useAuth';
import { useChatMessages, useMarkChatRead, useSendChatMessage } from './api';
import { openChatSocket } from './ws';
import { useRealContract, useRealContractTimeline } from '../contracts/realApi';
import { isChatEvent, timelineTitle } from '../contracts/timelineView';
import { bucketOf } from '../contracts/realStatus';
import { draftEditPath } from '../contractNew/draftResume';
import { CounterpartyLink } from '../counterparty/CounterpartyLink';
import styles from './ChatThreadPane.module.css';
import { apiErrorText } from '../../shared/apiErrorText';

interface ChatThreadPaneProps {
  contractId: string | undefined;
  /**
   * Куда ведёт стрелка «назад». Передаёт только отдельная страница
   * `/chat/{contractId}` (мобильный сценарий); в detail-колонке /chat
   * стрелка не нужна — список и так рядом (DEV-19 §2).
   */
  backTo?: string;
}

/**
 * Тред переписки по договору (ADR-112): пузыри свои/чужие (свои — по
 * профилям текущего пользователя), автопрокрутка вниз, открытие треда
 * отмечает чужие сообщения прочитанными. Поллинг 5 с — ADR-112 §6.
 * Сообщения append-only: правок и удалений нет. Используется и отдельной
 * страницей `/chat/{contractId}`, и detail-колонкой /chat на десктопе.
 */
export function ChatThreadPane({ contractId, backTo }: ChatThreadPaneProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const { data: me } = useCurrentUser();
  const navigate = useNavigate();
  const { data: contract } = useRealContract(contractId);
  const { data, isPending, error, refetch } = useChatMessages(contractId);
  // DEV-20 §5: события сделки идут системной плашкой в той же ленте — иначе
  // переписка и то, что по договору произошло, читаются как два разных мира.
  // Хроника — тот же `GET /contracts/{id}/timeline`, что во вкладке «История»
  // (ADR-134), подписи приходят локализованными с бэка. Сам чат из хроники
  // отфильтрован (`isChatEvent`) — иначе сообщения задвоились бы.
  const timelineQ = useRealContractTimeline(contractId);
  const send = useSendChatMessage(contractId);
  const markRead = useMarkChatRead(contractId);
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const qc = useQueryClient();

  // ADR-113: мгновенная доставка по WebSocket; поллинг выше остаётся
  // страховкой. Кадр — сигнал перечитать тред (и список диалогов).
  useEffect(() => {
    if (!contractId) return undefined;
    return openChatSocket(contractId, () => {
      void qc.invalidateQueries({ queryKey: ['chat', 'messages', contractId] });
      void qc.invalidateQueries({ queryKey: ['chat', 'threads'] });
    });
  }, [contractId, qc]);

  const unread = data?.unread_count ?? 0;
  useEffect(() => {
    if (unread > 0) markRead.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- по факту появления непрочитанных
  }, [unread]);

  useEffect(() => {
    // jsdom не реализует scrollIntoView — прокрутка только там, где она есть.
    bottomRef.current?.scrollIntoView?.({ block: 'end' });
  }, [data?.items.length]);

  const myProfileIds = new Set((me?.profiles ?? []).map((p) => p.id));
  const counterpartyId = contract?.parties.find((p) => !myProfileIds.has(p.profile_id))?.profile_id;

  async function submit(): Promise<void> {
    const text = draft.trim();
    if (!text || send.isPending) return;
    await send.mutateAsync(text);
    setDraft('');
  }

  if (isPending) return <Skeleton height={240} />;
  if (error) {
    return (
      <ErrorState
        title={t('common.unexpectedErrorTitle')}
        text={apiErrorText(error)}
        code={error instanceof ApiError ? error.code : undefined}
        retryLabel={t('common.retry')}
        onRetry={() => void refetch()}
      />
    );
  }

  // Одна лента: сообщения и события в общем порядке по времени.
  const feed: Array<
    | { kind: 'message'; at: string; message: NonNullable<typeof data>['items'][number] }
    | { kind: 'event'; at: string; event: RealTimelineEvent }
  > = [
    ...(data?.items ?? []).map((m) => ({ kind: 'message' as const, at: m.created_at, message: m })),
    ...(timelineQ.data ?? [])
      .filter((e) => !isChatEvent(e) && !!timelineTitle(e))
      .map((e) => ({ kind: 'event' as const, at: e.occurred_at, event: e })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  return (
    <div className={styles.thread}>
      <div className={styles.head}>
        {backTo ? (
          <Link to={backTo} className={styles.back} aria-label={t('contract.chat.backToList')}>
            <Icon name="back" size={20} directional />
          </Link>
        ) : null}
        <Link to={`/contracts/${contractId}`} className={styles.contractLink}>
          {contract?.title || t('contract.chat.threadTitleFallback')}
        </Link>
        {/* Бэклог 2026-08-21: собеседник кликабелен, хендл копируется. */}
        {counterpartyId ? (
          <CounterpartyLink profileId={counterpartyId} showAvatar data-testid="chat-counterparty" />
        ) : null}
        {/* Замечание владельца 06.09: из чата по черновику договор начинали
            заново через «+» и теряли всё, что уже есть на черновике (тип,
            роль, контрагент). Кнопка ведёт в мастер К ЭТОМУ черновику
            (ADR-104: черновик редактируют, а не плодят новые). */}
        {contract && bucketOf(contract) === 'drafts' && contract.parties.some((p) => myProfileIds.has(p.profile_id)) ? (
          <Button
            variant="outline"
            size="sm"
            className={styles.draftCta}
            onClick={() => navigate(draftEditPath(contract.id))}
            data-testid="chat-draft-continue"
          >
            {t('contract.chat.draftContinue')}
          </Button>
        ) : null}
      </div>

      <ChatLog data-testid="chat-messages">
        {feed.length === 0 ? <p className={styles.noMessages}>{t('contract.chat.noMessages')}</p> : null}
        {feed.map((item) =>
          item.kind === 'message' ? (
            <ChatBubble
              key={item.message.id}
              direction={myProfileIds.has(item.message.sender_profile_id) ? 'out' : 'in'}
              timeLabel={formatDateTime(item.message.created_at, i18n.language)}
            >
              {item.message.body}
            </ChatBubble>
          ) : (
            <ChatSystemEvent key={item.event.event_id} timeLabel={formatDateTime(item.event.occurred_at, i18n.language)}>
              {timelineTitle(item.event)}
            </ChatSystemEvent>
          ),
        )}
        <div ref={bottomRef} />
      </ChatLog>

      <ChatComposer
        value={draft}
        onChange={setDraft}
        onSubmit={() => void submit()}
        placeholder={t('contract.chat.inputPlaceholder')}
        inputLabel={t('contract.chat.inputLabel')}
        sendLabel={t('contract.chat.send')}
        sending={send.isPending}
        data-testid="chat-input"
      />
    </div>
  );
}
