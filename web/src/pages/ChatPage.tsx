import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '@porukam/core';
import { Button, EmptyState, ErrorState, Icon, MasterDetail, ScreenHeader, Skeleton, Surface, useDesktopLayout } from '@porukam/ui';
import { useShellHeader } from '../features/shell/shellHeader';
import { useChatThreads } from '../features/chat/api';
import { ChatThreadPane } from '../features/chat/ChatThreadPane';
import { ChatThreadRow } from '../features/chat/ChatThreadRow';
import styles from './ChatPage.module.css';
import { apiErrorText } from '../shared/apiErrorText';

/**
 * `/chat` — диалоги по договорам (ADR-112): договоры с перепиской, свежие
 * сверху, счётчик непрочитанного. Новая переписка начинается из договора —
 * отдельного «начать чат с человеком» нет намеренно: переписка платформы
 * живёт в контексте сделки (доказательная база).
 *
 * Десктоп (DEV-19 §2, отсмотр 2026-08-24): master-detail — список диалогов
 * слева, открытый тред справа (`?sel=`, без ухода со списка); `<1024` —
 * список во всю ширину, тред отдельной страницей `/chat/{contractId}`.
 */
export function ChatPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isDesktop = useDesktopLayout();
  const [searchParams, setSearchParams] = useSearchParams();
  const selected = searchParams.get('sel');
  const { data, isPending, error, refetch } = useChatThreads();

  function openThread(contractId: string): void {
    if (isDesktop) {
      const next = new URLSearchParams(searchParams);
      next.set('sel', contractId);
      setSearchParams(next);
      return;
    }
    navigate(`/chat/${contractId}`);
  }

  // «Начать переговоры» (ADR-116) — вход в запрос на сотрудничество, виден
  // во всех состояниях списка (в т.ч. когда переписок ещё нет). DEV-20 §4:
  // живёт в компактной шапке экрана, не отдельной полосой над списком.
  // Финал доска A: на телефоне это «+» в шапке оболочки справа от «Чат».
  const shell = useShellHeader({
    actions: (
      <button
        type="button"
        className={styles.plusBtn}
        aria-label={t('contract.chat.inquiryButton')}
        title={t('contract.chat.inquiryButton')}
        onClick={() => navigate('/chat/new')}
        data-testid="chat-inquiry-plus"
      >
        <Icon name="plus" size={24} />
      </button>
    ),
  });
  const inquiryCta = (
    <>
      {shell.portal}
      <ScreenHeader
        title={t('nav.chat')}
        inShell={shell.inShell}
        actions={
          <Button variant="primary" size="sm" onClick={() => navigate('/chat/new')} data-testid="chat-inquiry-cta">
            {t('contract.chat.inquiryButton')}
          </Button>
        }
      />
    </>
  );

  if (isPending) {
    return (
      <div className={styles.page} aria-busy="true">
        <Skeleton height={56} />
        <Skeleton height={56} />
      </div>
    );
  }
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
  if (!data || data.length === 0) {
    return (
      <div className={styles.page}>
        {inquiryCta}
        <EmptyState icon="chat" title={t('contract.chat.emptyTitle')} text={t('contract.chat.emptyText')} />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {inquiryCta}
      <MasterDetail
      detailLabel={t('common.details')}
      detail={() =>
        selected ? (
          <ChatThreadPane contractId={selected} />
        ) : (
          <EmptyState icon="chat" title={t('contract.chat.paneSelectTitle')} text={t('contract.chat.paneSelectText')} />
        )
      }
      list={
        /* DEV-20 §2/§5: диалоги — строки на одной поверхности (аватар-лид,
           сделка и последнее сообщение во второй строке). */
        <Surface bleed data-testid="chat-threads">
          {data.map((thread) => (
            <ChatThreadRow
              key={thread.contract_id}
              thread={thread}
              selected={thread.contract_id === selected}
              onOpen={() => openThread(thread.contract_id)}
            />
          ))}
        </Surface>
      }
      />
    </div>
  );
}
