import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { ApiError, type ContractRole, type Dispute, type DisputeStatus, type RealEvidence, type WarrantyClaim } from '@porukam/core';
import { Badge, Button, Callout, Card, Disclosure, ErrorState, LtrText, PhotoViewer, Skeleton, type BadgeTone } from '@porukam/ui';
import { downloadEvidence, useContractWarrantyClaims, useDispute, useDisputeEvidence } from '../features/disputes/api';
import { DisputeActions, MAX_FIX_ROUNDS } from '../features/disputes/DisputeActions';
import { DisputeFeedAttachments } from '../features/disputes/DisputeFeedAttachments';
import { DisputeWindowsList } from '../features/disputes/DisputeWindowsList';
import { CounterpartyLink } from '../features/counterparty/CounterpartyLink';
import { useRealContract } from '../features/contracts/realApi';
import { useRealMilestone, useRealMilestoneEvidence } from '../features/stageExecution/realApi';
import { useCurrentUser } from '../features/auth/useAuth';
import { useFormatters } from '../shared/formatters';
import { PageHead } from '../features/contracts/cardCompact/CardBlocks';
import { apiErrorText } from '../shared/apiErrorText';
import styles from './DisputePage.module.css';

const STATUS_TONE: Record<DisputeStatus, BadgeTone> = {
  open: 'red',
  awaiting_fix: 'amber',
  awaiting_discount: 'amber',
  resolved: 'green',
};

const STATUS_KEY: Record<DisputeStatus, string> = {
  open: 'dispute.statusOpen',
  awaiting_fix: 'dispute.statusAwaitingFix',
  awaiting_discount: 'dispute.statusAwaitingDiscount',
  resolved: 'dispute.statusResolved',
};

/** Детальный код исхода (`resolution_type`) — он информативнее грубого
 * `outcome` (ADR-131 §6: `accepted` и `withdrawn` оба «resolved», но это
 * разные факты). Неизвестный код печатаем как есть — не прячем. */
const RESOLUTION_KEY: Record<string, string> = {
  accepted: 'dispute.resolutionAccepted',
  withdrawn: 'dispute.resolutionWithdrawn',
  discount_accepted: 'dispute.resolutionDiscountAccepted',
  cap_reached: 'dispute.resolutionCapReached',
  escalated_to_court: 'dispute.resolutionEscalatedToCourt',
  warranty_satisfied: 'dispute.resolutionWarrantySatisfied',
  warranty_declined: 'dispute.resolutionWarrantyDeclined',
  warranty_auto_satisfied: 'dispute.resolutionWarrantyAutoSatisfied',
};

interface FeedEntry {
  id: string;
  at: string;
  text: string;
  /** Служебная приписка к событию (срок окна, код исхода) — НЕ текст стороны. */
  note?: string;
  /** Что человек написал: печатается целиком, длинное — под «показать
   * полностью» (замечание владельца 05.09: ответ было не прочитать). */
  comment?: string;
  /** Идентификаторы приложенных доказательств — плитками под текстом. */
  evidence?: string[];
}

/** Длиннее — сворачиваем: примерно четыре строки на экране 360px. */
const COMMENT_CLAMP_CHARS = 220;

/**
 * Карточка разногласия `/disputes/{id}` (этап 7, ADR-131).
 *
 * Один запрос: `DisputeSerializer` уже несёт раунды исправления, предложения
 * скидки и окна оспаривания — второго агрегата под карточку на бэке нет и не
 * нужно. Заголовок договора и сумма спорного листа дотягиваются отдельно
 * (`GET /contracts/{id}`, `GET /milestones/{id}`) — сериализатор спора отдаёт
 * только идентификаторы.
 *
 * Реплики сторон (`POST /disputes/{id}/respond`) приходят в `replies`
 * (`DisputeReplySerializer`) — в ленте это строка с текстом ответа, а не
 * «следы» (закрытое окно + файлы). Доказательства из `GET /disputes/{id}/
 * evidence` в ленту попадают только те, что не приложены к реплике или
 * раунду устранения — иначе один факт печатался бы дважды.
 *
 * Гарантийная претензия (`kind=warranty`, ADR-133) — отдельный ресурс
 * (`GET /contracts/{id}/warranty-claims`, по `dispute_id`): её состояние
 * («ждёт подтверждения заказчика», окно, раунды устранения) — на этой же
 * карточке, своего экрана у претензии нет.
 */
/** Пункт блока «Как решаются споры» — форма записи в `dispute.howItems`. */
interface HowItem {
  title: string;
  text: string;
}

export function DisputePage(): JSX.Element {
  const { disputeId = '' } = useParams();
  const { t } = useTranslation();
  const { formatDateTime, formatDate, formatMoney, formatCountdown } = useFormatters();
  const { data: dispute, isPending, error, refetch } = useDispute(disputeId);
  const { data: me } = useCurrentUser();
  const contractQ = useRealContract(dispute?.contract_id);
  const milestoneQ = useRealMilestone(dispute?.milestone_id ?? undefined);
  const evidenceQ = useDisputeEvidence(disputeId);
  // Второй источник метаданных вложений: доказательства СПОРНОГО ЛИСТА. С них
  // спор и открывают, но `dispute_id` у них пустой, поэтому в
  // `GET /disputes/{id}/evidence` (фильтр по `dispute_id`) их нет — без этого
  // запроса у половины плиток не было бы ни имени, ни типа файла.
  const milestoneEvidenceQ = useRealMilestoneEvidence(dispute?.milestone_id ?? undefined);
  const claimsQ = useContractWarrantyClaims(dispute?.contract_id, dispute?.kind === 'warranty');
  // Просмотрщик вложений — тот же контур, что на экране этапа: миниатюра
  // по запросу, «Скачать» ведёт к оригиналу (`GET /evidence/{id}/download`).
  const [viewerFile, setViewerFile] = useState<{ id: string; name: string; src?: string } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Object URL живёт ровно столько, сколько открыт просмотрщик (тот же приём,
  // что в `StagePage`); data-URL миниатюры отзывать нечего.
  useEffect(
    () => () => {
      if (viewerFile?.src?.startsWith('blob:')) URL.revokeObjectURL(viewerFile.src);
    },
    [viewerFile],
  );

  async function openEvidence(item: { id: string; name: string; src?: string }): Promise<void> {
    setViewerFile(item);
    // Миниатюру плитка уже загрузила — второй раз не ходим. Её нет (у файла
    // не было встроенного превью) — показываем ОРИГИНАЛ: «посмотреть фото»
    // это и есть просьба владельца, а иконка с подписью её не закрывает.
    if (item.src) return;
    try {
      const blob = await downloadEvidence(item.id);
      setViewerFile({ ...item, src: URL.createObjectURL(blob) });
    } catch {
      // Оригинал не отдался (нет прав, файл вычищен по сроку хранения) —
      // просмотрщик скажет это словами и предложит скачать.
    }
  }

  async function saveEvidence(item: { id: string; name: string }): Promise<void> {
    setDownloading(true);
    try {
      const blob = await downloadEvidence(item.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = item.name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } finally {
      setDownloading(false);
    }
  }

  if (isPending) {
    return (
      <div className={styles.wrap} aria-busy="true">
        <Skeleton width="60%" height={30} />
        <Skeleton width="100%" height={180} radius="var(--pr-r-lg)" />
        <Skeleton width="100%" height={240} radius="var(--pr-r-lg)" />
      </div>
    );
  }

  if (error || !dispute) {
    return (
      <div className={styles.wrap}>
        <ErrorState
          title={t('dispute.errorLoadTitle')}
          text={apiErrorText(error)}
          code={error instanceof ApiError ? error.code : undefined}
          retryLabel={t('common.retry')}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  const counterparty = dispute.counterparty;
  // Роль читателя — обратная роли контрагента (`counterparty` уже посчитан
  // ОТНОСИТЕЛЬНО читателя, ADR-131 §9). Без контрагента роль неизвестна.
  const myRole: ContractRole | null = counterparty ? (counterparty.role === 'customer' ? 'contractor' : 'customer') : null;
  const milestone = milestoneQ.data;
  const milestoneAmount =
    milestone && milestone.amount && milestone.amount_currency
      ? { amount: milestone.amount, currency: milestone.amount_currency }
      : null;

  const claim: WarrantyClaim | null = dispute.kind === 'warranty' ? (claimsQ.data ?? []).find((c) => c.dispute_id === dispute.id) ?? null : null;
  const feed = buildFeed(dispute, claim);
  const howRaw = t('dispute.howItems', { returnObjects: true }) as HowItem[];
  const howItems = Array.isArray(howRaw) ? howRaw : [];
  // Предложение скидки, по которому ждут подписи допника (ADR-131 §3).
  const pendingDiscount = dispute.discount_agreements.find((d) => d.status === 'proposed');
  const attached = new Set<string>([
    ...dispute.evidence,
    ...(dispute.replies ?? []).flatMap((r) => r.evidence),
    ...(claim?.fixes ?? []).flatMap((r) => [...r.evidence, ...r.contest_evidence]),
  ]);
  for (const item of evidenceQ.data ?? []) {
    if (attached.has(item.id)) continue;
    feed.push({
      id: `ev-${item.id}`,
      at: item.created_at,
      text: t('dispute.feedEvidence', { name: item.file_name }),
      evidence: [item.id],
    });
  }
  feed.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  // Метаданные вложений: доказательства спора + доказательства спорного листа
  // (с них спор открывают, `dispute_id` у них пустой). Чего нет ни там, ни
  // там — всё равно скачивается по id, плитка просто без имени.
  const evidenceMeta = new Map<string, RealEvidence>();
  for (const item of [...(evidenceQ.data ?? []), ...(milestoneEvidenceQ.data ?? [])]) evidenceMeta.set(item.id, item);

  // Исход — из заявки, если она закрыта (у неё же будущий признак «авто»:
  // в `WarrantyClaimSerializer` его пока нет, автоподтверждение по свипу
  // приходит как обычный `warranty_satisfied`; `warranty_auto_satisfied`
  // здесь — задел, не факт бэка).
  const resolutionType = claim?.status === 'resolved' && claim.resolution_type ? claim.resolution_type : dispute.resolution_type;
  const resolutionKey = resolutionType ? RESOLUTION_KEY[resolutionType] : undefined;
  const claimRoundsLeft = claim ? claim.fix_rounds_left ?? Math.max(MAX_FIX_ROUNDS - (claim.fix_rounds_used ?? 0), 0) : null;
  const awaitingConfirm = !!claim && claim.status === 'awaiting_confirmation' && dispute.status !== 'resolved';

  return (
    <div className={styles.wrap} data-testid="dispute-page">
      {/* Доска B «Спор»: «‹ Спор по этапу · статус» → название этапа →
          строка «договор · этап · сумма» → факты мелко. */}
      <PageHead
        title={dispute.kind === 'warranty' ? t('dispute.kindWarranty') : t('dispute.kindMilestone')}
        onBack={() => history.back()}
        backLabel={t('common.back')}
        backTestId="dispute-back"
        aside={
          <span data-testid="dispute-status">
            <Badge tone={STATUS_TONE[dispute.status]} dot>
              {t(STATUS_KEY[dispute.status])}
            </Badge>
          </span>
        }
      />

      <div className={styles.head}>
        <h1 className={styles.title}>
          {dispute.milestone_id ? milestone?.title || t('dispute.milestoneUnknown') : contractQ.data?.title || t('contracts.titleUnset')}
        </h1>
        <p className={styles.meta}>
          <Link to={`/contracts/${dispute.contract_id}`} data-testid="dispute-contract-link" className={styles.metaLink}>
            {contractQ.data?.title || t('contracts.titleUnset')}
          </Link>
          {dispute.milestone_id ? (
            <>
              {' · '}
              <Link
                to={`/contracts/${dispute.contract_id}/stages/${dispute.milestone_id}`}
                data-testid="dispute-milestone-link"
                className={styles.metaLink}
              >
                {t('dispute.milestoneLabel')}
              </Link>
            </>
          ) : null}
          {milestoneAmount ? (
            <>
              {' · '}
              <LtrText as="span">{formatMoney(milestoneAmount)}</LtrText>
            </>
          ) : null}
        </p>
        <div className={styles.badges}>
          {dispute.status !== 'resolved' && dispute.days_to_cap !== null ? (
            <span data-testid="dispute-days-to-cap">
              <Badge tone="neutral">{t('dispute.daysToCap', { count: dispute.days_to_cap })}</Badge>
            </span>
          ) : null}
          {dispute.kind === 'milestone' ? (
            <span data-testid="dispute-fix-rounds">
              <Badge tone="neutral">
                {t('dispute.fixRoundsLeft', { left: dispute.fix_rounds_left, max: MAX_FIX_ROUNDS })}
              </Badge>
            </span>
          ) : null}
          {claim && claim.status !== 'resolved' && claimRoundsLeft !== null ? (
            <span data-testid="warranty-fix-rounds">
              <Badge tone="neutral">{t('dispute.warrantyRoundsLeft', { left: claimRoundsLeft, max: MAX_FIX_ROUNDS })}</Badge>
            </span>
          ) : null}
          {awaitingConfirm ? (
            <span data-testid="warranty-claim-status">
              <Badge tone="teal" dot>
                {t('dispute.warrantyStatusFixSubmitted')}
              </Badge>
            </span>
          ) : null}
        </div>
        <p className={styles.facts}>
          <span className={styles.fact}>
            <span className={styles.factLabel}>{t('dispute.counterpartyLabel')}</span>{' '}
            {counterparty ? (
              <CounterpartyLink profileId={counterparty.profile_id} name={counterparty.display_name} showHandle={false} data-testid="dispute-counterparty" />
            ) : (
              <span>{t('dispute.counterpartyUnknown')}</span>
            )}
          </span>
          <span className={styles.fact}>
            <span className={styles.factLabel}>{t('dispute.openedLabel')}</span> {formatDate(dispute.opened_at, { legal: true })}
          </span>
          {dispute.resolved_at ? (
            <span className={styles.fact} data-testid="dispute-resolution">
              <span className={styles.factLabel}>{t('dispute.resolvedLabel')}</span> {formatDate(dispute.resolved_at, { legal: true })}
              {resolutionKey ? ` · ${t(resolutionKey)}` : resolutionType ? ` · ${resolutionType}` : ''}
            </span>
          ) : null}
        </p>
      </div>

      {/* Окно подтверждения устранения (ADR-133): заказчику — таймер и
          честное «молчание = претензия закроется сама», исполнителю — «ждём
          заказчика до …». `acceptance_deadline_at: null` — уведомление ещё
          не размещено в ЛК, окно не тикает (ADR-057), таймер не рисуем. */}
      {awaitingConfirm && claim ? (
        <Callout
          tone={myRole === 'contractor' ? 'neutral' : 'info'}
          title={t(myRole === 'contractor' ? 'dispute.warrantyWaitingTitle' : 'dispute.warrantyConfirmTitle')}
        >
          <div data-testid="warranty-confirm-callout">
            <p>
              {claim.acceptance_deadline_at
                ? t(myRole === 'contractor' ? 'dispute.warrantyWaitingText' : 'dispute.warrantyConfirmLeft', {
                    left: formatCountdown(claim.acceptance_deadline_at, Date.now()),
                    date: formatDateTime(claim.acceptance_deadline_at),
                  })
                : t('dispute.windowNotAnchored')}
            </p>
            <p>{t('dispute.warrantyConfirmAutoNote')}</p>
          </div>
        </Callout>
      ) : null}

      {/* Окна оспаривания этого разногласия — прямо на карточке: возражение
          подаётся там же, где человек читает, что именно оспаривается. */}
      <DisputeWindowsList windows={dispute.windows} testId="dispute-windows" />

      {/* Предложенная скидка = допник на подписи (ADR-131 §3): «принять» —
          значит подписать, поэтому здесь вход на экран допника, не кнопка. */}
      {pendingDiscount ? (
        <Callout tone="info" title={t('dispute.discountPendingTitle')}>
          <p>{t('dispute.discountPendingText')}</p>
          <Link to={`/contracts/${dispute.contract_id}/amendments/${pendingDiscount.amendment_id}`} data-testid="dispute-pending-discount-link">
            {t('dispute.discountSignLink')}
          </Link>
        </Callout>
      ) : null}

      <Card>
        <h2 className={styles.sectionTitle}>{t('dispute.feedTitle')}</h2>
        {/* Таймлайн-строки (доска B): точка-статус слева, событие, под ним
            дата и пояснение; строки разделены пунктирным hairline. */}
        <ul className={styles.feed} data-testid="dispute-feed">
          {feed.map((e, i) => (
            <li key={e.id} className={styles.feedItem} data-tone={i === 0 ? 'done' : i === feed.length - 1 && dispute.status !== 'resolved' ? 'open' : 'mid'}>
              <span className={styles.feedDot} aria-hidden="true" />
              <div className={styles.feedBody}>
                <span className={styles.feedText}>{e.text}</span>
                <span className={styles.feedNote}>
                  <span className={styles.feedTime}>{formatDateTime(e.at)}</span>
                  {e.note ? ` · ${e.note}` : ''}
                </span>
                {/* Текст стороны — ЦЕЛИКОМ и отдельным блоком, а не припиской
                    к дате: раньше ответ второй стороны терялся в служебной
                    строке и обрезался (замечание владельца 05.09). */}
                {e.comment ? (
                  <div className={styles.feedComment} data-testid="dispute-feed-comment">
                    <span
                      className={
                        e.comment.length > COMMENT_CLAMP_CHARS && !expanded[e.id]
                          ? `${styles.feedCommentText} ${styles.feedCommentClamped}`
                          : styles.feedCommentText
                      }
                    >
                      {e.comment}
                    </span>
                    {e.comment.length > COMMENT_CLAMP_CHARS ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setExpanded((prev) => ({ ...prev, [e.id]: !prev[e.id] }))}
                        data-testid="dispute-feed-comment-toggle"
                      >
                        {t(expanded[e.id] ? 'dispute.feedShowLess' : 'dispute.feedShowMore')}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                <DisputeFeedAttachments
                  ids={e.evidence ?? []}
                  meta={evidenceMeta}
                  metaPending={evidenceQ.isPending || (!!dispute.milestone_id && milestoneEvidenceQ.isPending)}
                  onOpen={(item) => void openEvidence(item)}
                  onDownload={(item) => void saveEvidence(item)}
                  testId="dispute-feed-attachments"
                />
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {/* Регламент (DEV-20_2 §4/§11) — свёрнутая строка-заголовок между
          лентой и действиями, как на доске B «Спор». */}
      <Disclosure variant="row" label={t('dispute.howTitle')} data-testid="dispute-how">
        <ul className={styles.howList}>
          {howItems.map((it) => (
            <li key={it.title}>
              <b className={styles.howTitle}>{it.title}</b>
              {' — '}
              {it.text}
            </li>
          ))}
        </ul>
      </Disclosure>

      {dispute.status === 'resolved' ? (
        <Callout tone="neutral" title={t('dispute.closedTitle')}>
          {t('dispute.closedText')}
        </Callout>
      ) : (
        <DisputeActions dispute={dispute} myRole={myRole} myUserId={me?.id} milestoneAmount={milestoneAmount} claim={claim} />
      )}

      {/* `fallbackText` даём всегда: он нужен и когда байты не пришли, и
          когда пришли, но картинкой не оказались — решает просмотрщик. */}
      <PhotoViewer
        open={!!viewerFile}
        src={viewerFile?.src}
        name={viewerFile?.name}
        onClose={() => setViewerFile(null)}
        closeLabel={t('common.close')}
        fallbackText={t('dispute.evidencePreviewUnavailable')}
        downloadLabel={t('dispute.evidenceDownload')}
        onDownload={viewerFile ? () => void saveEvidence(viewerFile) : undefined}
        downloading={downloading}
      />
    </div>
  );

  /** Лента строится ИЗ САМОГО ответа (вложенные раунды/скидки/окна) — своего
   * ресурса «события спора» на бэке нет, и заводить его ради тех же данных
   * было бы вторым агрегатом того же факта. */
  function buildFeed(d: Dispute, c: WarrantyClaim | null): FeedEntry[] {
    const out: FeedEntry[] = [
      {
        id: 'opened',
        at: d.opened_at,
        text: d.kind === 'warranty' ? t('dispute.feedOpenedWarranty') : t('dispute.feedOpened'),
        comment: c?.description || undefined,
        evidence: d.evidence,
      },
    ];
    // Реплики — своей строкой с текстом (`replies`), у старого ответа бэка
    // поля нет — тогда ленту держат окна и доказательства, как раньше.
    for (const r of d.replies ?? []) {
      out.push({
        id: `reply-${r.id}`,
        at: r.created_at,
        text: t('dispute.feedReply'),
        comment: r.comment || undefined,
        evidence: r.evidence,
      });
    }
    // Устранения по претензии (ADR-133): «устранил» исполнителя и
    // «не устранено» заказчика — пара действий, как раунд исправления.
    for (const r of c?.fixes ?? []) {
      out.push({
        id: `wfix-${r.id}`,
        at: r.submitted_at,
        text: t('dispute.feedWarrantyFixSubmitted', { round: r.round }),
        comment: r.comment || undefined,
        evidence: r.evidence,
      });
      if (r.contested_at) {
        out.push({
          id: `wcontest-${r.id}`,
          at: r.contested_at,
          text: t('dispute.feedWarrantyContested', { round: r.round }),
          comment: r.contest_comment || undefined,
          evidence: r.contest_evidence,
        });
      }
    }
    for (const fr of d.fix_requests) {
      out.push({
        id: `fix-${fr.id}`,
        at: fr.requested_at,
        text: t('dispute.feedFixRequested', { round: fr.round }),
        comment: fr.comment || undefined,
      });
      if (fr.resubmitted_at) {
        out.push({
          id: `fix-done-${fr.id}`,
          at: fr.resubmitted_at,
          text: t('dispute.feedFixResubmitted', { round: fr.round }),
          comment: fr.resubmit_comment || undefined,
        });
      }
    }
    for (const da of d.discount_agreements) {
      out.push({
        id: `discount-${da.id}`,
        at: da.created_at,
        text: t('dispute.feedDiscountProposed', {
          // Деньги — парой (сумма, валюта) через `formatMoney` (web/CLAUDE.md §2 п.3).
          from: formatMoney({ amount: da.old_amount, currency: da.old_amount_currency }),
          to: formatMoney({ amount: da.new_amount, currency: da.new_amount_currency }),
        }),
        comment: da.anti_waiver_note || undefined,
      });
      if (da.decided_at) {
        out.push({
          id: `discount-done-${da.id}`,
          at: da.decided_at,
          text: da.status === 'accepted' ? t('dispute.feedDiscountAccepted') : t('dispute.feedDiscountDeclined'),
        });
      }
    }
    for (const w of d.windows) {
      out.push({
        id: `window-${w.id}`,
        at: w.opened_at,
        text: t(w.kind === 'termination_notice' ? 'dispute.feedWindowTermination' : 'dispute.feedWindowResponse'),
        note: w.deadline_at
          ? t('dispute.windowDeadline', { date: formatDateTime(w.deadline_at) })
          : t('dispute.windowNotAnchored'),
      });
      if (w.contested === true && w.contested_at) {
        out.push({ id: `window-contested-${w.id}`, at: w.contested_at, text: t('dispute.feedWindowContested') });
      } else if (w.contested === false && w.closed_at) {
        out.push({ id: `window-expired-${w.id}`, at: w.closed_at, text: t('dispute.feedWindowExpired') });
      }
    }
    if (d.resolved_at) {
      const type = c?.status === 'resolved' && c.resolution_type ? c.resolution_type : d.resolution_type;
      const key = type ? RESOLUTION_KEY[type] : undefined;
      out.push({
        id: 'resolved',
        at: d.resolved_at,
        text: t(
          type === 'warranty_declined'
            ? 'dispute.feedWarrantyDeclined'
            : type === 'warranty_satisfied'
              ? 'dispute.feedWarrantySatisfied'
              : type === 'warranty_auto_satisfied'
                ? 'dispute.feedWarrantyAutoSatisfied'
                : 'dispute.feedResolved',
        ),
        note: key ? t(key) : type || undefined,
      });
    }
    return out;
  }
}
