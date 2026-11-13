import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ApiError, type DisputeWindow, type WarrantyClaim } from '@porukam/core';
import { Button, Callout, Modal, SectionLabel, Surface, TextArea } from '@porukam/ui';
import { useContestWarrantyFix, useContestWindow, useDisputeWindows, useWarrantyClaims } from './api';
import { disputeErrorCode, disputeErrorKey } from './errorText';
import { useCurrentUser } from '../auth/useAuth';
import { useFormatters } from '../../shared/formatters';
import styles from './DisputeWindowsList.module.css';

const KIND_KEY: Record<DisputeWindow['kind'], string> = {
  dispute_response: 'dispute.windowKindResponse',
  termination_notice: 'dispute.windowKindTermination',
};

/**
 * Строка виджета: окно оспаривания (`DisputeWindow`) ЛИБО окно подтверждения
 * устранения по гарантийной претензии (ADR-133). Второе на бэке — не
 * `DisputeWindow`, а `DomainDeadline` заявки (`acceptance_deadline_at`), в
 * `GET /dispute-windows` его нет, а место у него то же: срок идёт, ответ —
 * одним нажатием. Возражается оно `POST /warranty-claims/{id}/contest`
 * (переход претензии), не `/dispute-windows/{id}/contest`.
 */
type WindowRow =
  | { id: string; kind: 'window'; window: DisputeWindow }
  | { id: string; kind: 'warranty_claim'; claim: WarrantyClaim };

export interface DisputeWindowsListProps {
  windows: DisputeWindow[];
  /** Претензии в `awaiting_confirmation`, где читатель — заказчик. */
  claims?: WarrantyClaim[];
  testId?: string;
}

/**
 * Окна оспаривания (ADR-019: одностороннее утверждение НЕ создаёт последствий
 * — оно открывает окно). Показываем только идущие (`closed_at === null`):
 * закрытое окно это уже факт ленты, а не место для действия.
 *
 * Пустой список НЕ рендерится вовсе — «окон нет» это не состояние экрана, а
 * отсутствие повода (постановка задачи: виджет пустым не показывается).
 */
export function DisputeWindowsList({ windows, claims = [], testId = 'dispute-windows' }: DisputeWindowsListProps): JSX.Element | null {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { formatCountdown, formatDateTime } = useFormatters();
  const contest = useContestWindow();
  const [openRow, setOpenRow] = useState<WindowRow | null>(null);
  const openClaim = openRow?.kind === 'warranty_claim' ? openRow.claim : null;
  const contestWarranty = useContestWarrantyFix({ claimId: openClaim?.id ?? '', disputeId: openClaim?.dispute_id, contractId: openClaim?.contract_id });
  const [comment, setComment] = useState('');
  const [err, setErr] = useState<unknown>(null);

  const rows: WindowRow[] = [
    ...windows.filter((w) => w.closed_at === null).map((w): WindowRow => ({ id: `dw-${w.id}`, kind: 'window', window: w })),
    ...claims.filter((c) => c.status === 'awaiting_confirmation').map((c): WindowRow => ({ id: `wc-${c.id}`, kind: 'warranty_claim', claim: c })),
  ];
  if (rows.length === 0) return null;

  function close(): void {
    setOpenRow(null);
    setComment('');
    setErr(null);
  }

  async function submit(): Promise<void> {
    if (!openRow) return;
    setErr(null);
    try {
      if (openRow.kind === 'warranty_claim') await contestWarranty.mutateAsync({ comment });
      else await contest.mutateAsync({ windowId: openRow.window.id, comment });
      close();
    } catch (e) {
      setErr(e);
    }
  }

  function deadlineLine(deadlineAt: string | null | undefined): string {
    // `deadline_at: null` — уведомление ещё не размещено в ЛК, окно НЕ
    // тикает (ADR-057): врать «осталось столько-то» нельзя, поэтому
    // честная строка вместо таймера.
    return deadlineAt
      ? t('dispute.windowLeft', { left: formatCountdown(deadlineAt, Date.now()), date: formatDateTime(deadlineAt) })
      : t('dispute.windowNotAnchored');
  }

  const key = disputeErrorKey(err);
  const title = err instanceof ApiError ? err.problem.title : undefined;
  const errText = err
    ? key
      ? t(key)
      : title && title !== disputeErrorCode(err)
        ? title
        : t('dispute.errorUnknown')
    : null;

  return (
    <section aria-label={t('dispute.windowsTitle')}>
      {/* Финал доска A: надпись раздела + строки во всю ширину, а не
          карточка с крупными кнопками на пол-экрана. */}
      <SectionLabel>{t('dispute.windowsTitle')}</SectionLabel>
      <Surface as="ul" bleed className={styles.list} data-testid={testId}>
        {rows.map((row) => {
          // Строка целиком — тап к месту события (замечание 03.09: без
          // отдельной подчёркнутой ссылки «Открыть договор»); кнопка справа —
          // маленькая, свой клик не отдаёт строке.
          const href =
            row.kind === 'window'
              ? row.window.dispute_id
                ? `/disputes/${row.window.dispute_id}`
                : `/contracts/${row.window.contract_id}`
              : row.claim.dispute_id
                ? `/disputes/${row.claim.dispute_id}`
                : `/contracts/${row.claim.contract_id}`;
          const openLabel = t(
            (row.kind === 'window' ? row.window.dispute_id : row.claim.dispute_id) ? 'dispute.windowOpenDispute' : 'dispute.windowOpenContract',
          );
          const kind = row.kind === 'window' ? t(KIND_KEY[row.window.kind]) : t('dispute.windowKindWarrantyFix');
          const deadline = deadlineLine(row.kind === 'window' ? row.window.deadline_at : row.claim.acceptance_deadline_at);
          return (
            <li
              key={row.id}
              className={styles.item}
              role="button"
              tabIndex={0}
              aria-label={`${kind} — ${openLabel}`}
              onClick={() => navigate(href)}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  navigate(href);
                }
              }}
            >
              <span className={styles.main}>
                <span className={styles.kind}>{kind}</span>
                <span className={styles.meta}>
                  {deadline}
                  {row.kind === 'warranty_claim' ? (
                    /* Молчание в этом окне — не «факт зафиксирован», а закрытие
                       претензии (автоподтверждение по свипу): говорим это прямо. */
                    <span data-testid={`window-auto-note-${row.claim.id}`}>{` · ${t('dispute.warrantyConfirmAutoNote')}`}</span>
                  ) : null}
                </span>
              </span>
              <span onClick={(e) => e.stopPropagation()}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setOpenRow(row)}
                  data-testid={row.kind === 'window' ? `contest-window-${row.window.id}` : `contest-claim-${row.claim.id}`}
                >
                  {t(row.kind === 'window' ? 'dispute.actionContest' : 'dispute.actionWarrantyContest')}
                </Button>
              </span>
            </li>
          );
        })}
      </Surface>

      <Modal
        open={openRow !== null}
        title={t(openClaim ? 'dispute.actionWarrantyContest' : 'dispute.contestTitle')}
        onClose={close}
        closeLabel={t('common.close')}
        actions={
          <>
            <Button variant="ghost" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={contest.isPending || contestWarranty.isPending}
              disabled={!!openClaim && !comment.trim()}
              onClick={() => void submit()}
              data-testid="contest-submit"
            >
              {t(openClaim ? 'dispute.actionWarrantyContest' : 'dispute.actionContest')}
            </Button>
          </>
        }
      >
        <div className={styles.form}>
          <p className={styles.note}>{t(openClaim ? 'dispute.warrantyContestNote' : 'dispute.contestNote')}</p>
          <TextArea
            label={t('dispute.commentLabel')}
            rows={4}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            data-testid="contest-comment"
          />
          {errText ? (
            <Callout tone="warn" title={t('dispute.errorActionTitle')}>
              <span data-testid="contest-error">{errText}</span>
            </Callout>
          ) : null}
        </div>
      </Modal>
    </section>
  );
}

/**
 * Виджет активных окон на рабочем столе (`/`): `GET /v1/dispute-windows?
 * active=true` — «активные окна оспаривания текущего профиля (для дашборда)»
 * из tech-spec.md §8.8. Своей ошибки не показывает: дашборд первичен, а окно
 * — вторичная полоса (тот же приём, что `attention` в `DashboardPage`).
 */
export function ActiveDisputeWindows(): JSX.Element | null {
  const { data } = useDisputeWindows(true);
  const claimsQ = useWarrantyClaims();
  const { data: me } = useCurrentUser();
  // Окно подтверждения устранения (ADR-133) — у ЗАКАЗЧИКА: претензию
  // подаёт он (`submitted_by_id` — id пользователя), исполнителю это окно
  // — ожидание, не действие.
  const claims = (claimsQ.data ?? []).filter((c) => c.status === 'awaiting_confirmation' && !!me && c.submitted_by_id === me.id);
  if ((!data || data.length === 0) && claims.length === 0) return null;
  return <DisputeWindowsList windows={data ?? []} claims={claims} testId="dashboard-dispute-windows" />;
}
