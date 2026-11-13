import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  hasContractFee,
  isEditable,
  type ContractDetail,
  type MilestoneNode,
  type MoneyLike,
  type NegotiationStatus,
  type RealMilestoneTreeNode,
  type RevisionAuthorRole,
} from '@porukam/core';
import {
  Badge,
  Button,
  Callout,
  ChecklistEditor,
  ContractPassport,
  ErrorState,
  FilterSheet,
  Icon,
  LtrText,
  MilestoneList,
  Modal,
  PassportLayout,
  PaymentPolicyLine,
  SelectField,
  Sheet,
  Skeleton,
  Logo,
  ScreenTabs,
  TextField,
  normalizeAmountInput,
  useDesktopLayout,
  type ChecklistDraftItem,
  type ScreenTabItem,
  type BadgeTone,
  type PassportRow,
} from '@porukam/ui';
import {
  useContract,
  useContractApi,
  useTimeline,
  useAddPayout,
  usePayoutAccounts,
} from '../features/contracts/api';
import { useViewerStore } from '../features/contracts/viewerStore';
import { CardActions, CardHead, CardSum, CardSummaryRow, PartyRows, cardCompactStyles as cc } from '../features/contracts/cardCompact/CardBlocks';
import { useActorStore } from '../features/actor/actorStore';
import {
  useAcceptAllRevisions,
  useAcceptRevision,
  useCounterRevision,
  useCreateRealChecklistItem,
  useCreateRealMilestone,
  useDeleteRealMilestone,
  useProposeRevision,
  useRealChecklistItems,
  useRealContractView,
  useRejectRevision,
  useRejectRealContract,
  useSendRealContract,
  useWithdrawRealContract,
  usePatchRealMilestone,
} from '../features/contracts/realApi';
import { useCurrentUser, useCurrentUserId } from '../features/auth/useAuth';
import { MUTED_STATUSES, realCardStatus } from '../features/contracts/realStatus';
import { PAY_LABEL_KEY, contractTypeLabelKey } from '../features/contracts/RealContractRow';
import { paymentOrderApplicableForType, paymentOrderLabelKey } from '../features/contractNew/paymentOrders';
import {
  CURRENT_MILESTONE_STATUSES,
  DONE_MILESTONE_STATUSES,
  MILESTONE_STATUS_KEY,
  leavesOf,
} from '../features/contracts/milestoneView';
import { isRealContractId } from '../features/contracts/realDispatch';
import { contractTabFromHash, legacyContractTabFromHash } from '../features/contracts/cardDeepLink';
import { DeleteDraftButton } from '../features/contracts/DeleteDraftButton';
import { CounterpartyLink } from '../features/counterparty/CounterpartyLink';
import { WarrantyClaimAction } from '../features/warranty/WarrantyClaimAction';
import { RealTermsPanel } from '../features/contracts/RealTermsPanel';
import { RealPaymentsPanel } from '../features/contracts/RealPaymentsPanel';
import { RealMaterialsBlock } from '../features/contracts/RealMaterialsBlock';
import { MaterialsChangedBadge, useMaterialsChangedBadge } from '../features/contracts/MaterialsChangedBadge';
import { isChatEvent, isNestedEvent, shortSubjectId, timelineKind, timelineSubjectLabelKey, timelineSubjectLink, timelineTitle } from '../features/contracts/timelineView';
import { isOpenAmendment } from '../features/contracts/RealAmendmentsBlock';
import { RealAmendmentsEntry, RealAmendmentsTab } from '../features/contracts/RealAmendmentsTab';
import { useContractAmendments } from '../features/contracts/realAmendmentsApi';
import { RealProposeRevisionModal } from '../features/contracts/RealProposeRevisionModal';
import { RetentionNotice } from '../features/contracts/RetentionNotice';
import { RevisionValueField } from '../features/contracts/RevisionValueField';
import { coerceRevisionValueForOption, revisionErrorText, useRevisionItems, type RevisionItemOption } from '../features/contracts/contractFields';
import { draftEditPath } from '../features/contractNew/draftResume';
import { useFormatters } from '../shared/formatters';
import { isFeatureEnabled } from '../shared/features';
import { useChatThreads } from '../features/chat/api';
import styles from './ContractDetailPage.module.css';

/** Единый статус договора (ADR-010) — те же ключи, что ContractsListPage.tsx. */
const CARD_STATUS_LABEL_KEY: Record<string, string> = {
  draft: 'contract.card.statusDraft',
  under_review: 'contract.card.statusUnderReview',
  rejected_by_counterparty: 'contract.card.statusRejectedByCounterparty',
  withdrawn_by_initiator: 'contract.card.statusWithdrawnByInitiator',
  pending_signature: 'contract.card.statusPendingSignature',
  awaiting_signatures: 'contract.card.statusAwaitingSignatures',
  signed: 'contract.card.statusSigned',
  in_progress: 'contract.card.statusInProgress',
  suspended: 'contract.card.statusSuspended',
  completed: 'contract.card.statusCompleted',
  terminated_by_customer: 'contract.card.statusTerminatedByCustomer',
  terminated_by_contractor: 'contract.card.statusTerminatedByContractor',
  under_warranty: 'contract.card.statusUnderWarranty',
  warranty_claim: 'contract.card.statusWarrantyClaim',
};

const STATUS_META: Record<NegotiationStatus, { tone: BadgeTone; key: string }> = {
  draft: { tone: 'neutral', key: 'contract.statusDraft' },
  under_review: { tone: 'amber', key: 'contract.statusUnderReview' },
  pending_signature: { tone: 'amber', key: 'contract.statusPendingSignature' },
  awaiting_signatures: { tone: 'amber', key: 'contract.statusAwaiting' },
  signed: { tone: 'green', key: 'contract.statusSigned' },
  rejected_by_counterparty: { tone: 'red', key: 'contract.statusRejected' },
  withdrawn_by_initiator: { tone: 'neutral', key: 'contract.statusWithdrawn' },
};

/** Диспетчер real/мок — правило в `isRealContractId` (общее для карточки,
 * подписания и этапа). */
export function ContractDetailPage(): JSX.Element {
  const { id = '' } = useParams();
  return isRealContractId(id) ? <RealContractDetail id={id} /> : <LegacyContractDetail id={id} />;
}

function LegacyContractDetail({ id }: { id: string }): JSX.Element {
  const { t } = useTranslation();
  const { data: c, isPending } = useContract(id);
  const [tab, setTab] = useState('overview');
  const [tabSheetOpen, setTabSheetOpen] = useState(false);
  const viewAs = useViewerStore((s) => s.viewAs);
  const setViewAs = useViewerStore((s) => s.setViewAs);
  // ADR-170 — то же, что у real-карточки, но по своим ключам вкладок.
  const hash = useLocation().hash;
  useEffect(() => {
    const target = legacyContractTabFromHash(hash);
    if (target) setTab(target);
  }, [hash]);

  if (isPending || !c) {
    return (
      <div className={`${styles.wrap} ${styles.narrow}`}>
        <Skeleton width="50%" height={30} />
        <Skeleton width="100%" height={200} />
      </div>
    );
  }

  const meta = STATUS_META[c.status];
  const openRevisions = c.revisions.filter((r) => r.status === 'open').length;
  /** Порядок важности: первые четыре — в строке вкладок, остальные — в воронке. */
  const legacyTabs: ScreenTabItem[] = [
    { key: 'overview', label: t('contract.tabs.overview') },
    { key: 'stages', label: t('contract.tabs.stages'), count: c.milestones.filter((m) => m.kind === 'leaf').length },
    { key: 'nego', label: t('contract.tabs.nego'), count: openRevisions },
    { key: 'sign', label: t('contract.tabs.sign') },
    { key: 'timeline', label: t('contract.tabs.timeline') },
  ];

  return (
    <div className={`${styles.wrap} ${styles.narrow}`}>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>{c.title}</h1>
          <div className={styles.sub}>
            <Badge tone={meta.tone} dot>
              {t(meta.key)}
            </Badge>
            <Badge tone="ink">{t(`segment.${c.segment}`)}</Badge>
            <Badge tone="neutral">{c.sphere}</Badge>
          </div>
        </div>
        <div className={styles.viewAs}>
          <span className={styles.viewAsLabel}>{t('contract.viewAs')}</span>
          <div className={styles.segmented} role="group" aria-label={t('contract.viewAsHint')}>
            <button
              type="button"
              className={`${styles.segBtn} ${viewAs === 'customer' ? styles.segBtnActive : ''}`}
              onClick={() => setViewAs('customer')}
              data-testid="viewas-customer"
            >
              {t('contract.roleCustomer')}
            </button>
            <button
              type="button"
              className={`${styles.segBtn} ${viewAs === 'contractor' ? styles.segBtnActive : ''}`}
              onClick={() => setViewAs('contractor')}
              data-testid="viewas-contractor"
            >
              {t('contract.roleContractor')}
            </button>
          </div>
        </div>
      </div>

      {/* DEV-20_2 §3: четыре вкладки в строке, «Хроника» — в шите по воронке. */}
      <ScreenTabs
        active={tab}
        onChange={setTab}
        ariaLabel={c.title}
        allowExtra
        items={legacyTabs.slice(0, 4)}
        onOpenFilters={() => setTabSheetOpen(true)}
        filtersLabel={t('contracts.filtersTitle')}
        filtersActive={!legacyTabs.slice(0, 4).some((it) => it.key === tab)}
      />

      <FilterSheet
        open={tabSheetOpen}
        onClose={() => setTabSheetOpen(false)}
        closeLabel={t('common.close')}
        title={t('contracts.filtersTitle')}
        categoryLabel={t('contracts.filterCategory')}
        categoryValue={tab}
        categoryOptions={legacyTabs.map((it) => ({ value: it.key, label: it.label }))}
        onCategoryChange={setTab}
        resetLabel={t('contracts.filtersReset')}
        onReset={() => setTab('overview')}
        applyLabel={t('common.apply')}
      />

      {tab === 'overview' && <OverviewPanel c={c} />}
      {tab === 'stages' && <StagesPanel c={c} />}
      {tab === 'nego' && <NegoPanel c={c} />}
      {tab === 'sign' && <SignPanel c={c} />}
      {tab === 'timeline' && <TimelinePanel id={c.id} />}
    </div>
  );
}

// ─────────────────────────────────────────── Обзор
function OverviewPanel({ c }: { c: ContractDetail }): JSX.Element {
  const { t } = useTranslation();
  const { formatMoney } = useFormatters();
  const api = useContractApi(c.id);
  const viewAs = useViewerStore((s) => s.viewAs);
  const [err, setErr] = useState<string | null>(null);
  const busy = (fn: () => Promise<unknown>) => () => void fn().catch((e) => setErr(e instanceof ApiError ? e.message : String(e)));

  return (
    <div className={styles.panel}>
      <Callout tone="operator" collapsible title={t('contract.operatorDisclaimer')}>
        {t('contract.operatorDisclaimerText')}
      </Callout>
      {c.tax_note ? <Callout tone="neutral" title={t('contract.taxNote')}>{c.tax_note}</Callout> : null}
      {/* ADR-137 требование 9: сроки хранения — в обзоре, свёрнуто. */}
      <RetentionNotice variant="compact" />

      <div className={styles.card}>
        <h3 className={styles.sectionTitle}>{t('contract.parties')}</h3>
        {c.parties.map((p) => (
          <div key={p.profile_id} className={styles.party}>
            <Icon name={p.role === 'customer' ? 'profile' : 'verified'} size={24} />
            <div>
              <div>
                {p.display_name} · {t(p.role === 'customer' ? 'contract.roleCustomer' : 'contract.roleContractor')}
              </div>
              <LtrText as="span" className={styles.handle}>{p.handle}</LtrText>
            </div>
          </div>
        ))}
        <div className={styles.rowBetween}>
          <span>{t('contract.total')}</span>
          <strong>
            <LtrText as="span">{formatMoney(c.total)}</LtrText>
          </strong>
        </div>
      </div>

      {err ? <Callout tone="warn">{err}</Callout> : null}

      <div className={styles.actions}>
        {c.status === 'draft' && (
          <Button variant="primary" onClick={busy(() => api.post('/send'))} data-testid="send-contract">
            {t('contract.send')}
          </Button>
        )}
        {c.status === 'under_review' && viewAs === c.initiator_role && (
          <Button variant="ghost" onClick={busy(() => api.post('/withdraw'))}>
            {t('contract.withdraw')}
          </Button>
        )}
        {c.status === 'under_review' && viewAs !== c.initiator_role && (
          <Button variant="destructive" onClick={busy(() => api.post('/reject'))}>
            {t('contract.reject')}
          </Button>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────── Этапы
function StagesPanel({ c }: { c: ContractDetail }): JSX.Element {
  const { t } = useTranslation();
  const { formatMoney } = useFormatters();
  const api = useContractApi(c.id);
  const [err, setErr] = useState<string | null>(null);
  const editable = isEditable(c.status);
  const run = (fn: () => Promise<unknown>) => fn().catch((e) => setErr(e instanceof ApiError ? e.message : String(e)));

  const leafSum = c.milestones
    .filter((m) => m.kind === 'leaf')
    .reduce((s, m) => s + Number(m.amount?.amount ?? 0), 0);
  const total = Number(c.total.amount);
  const match = leafSum.toFixed(2) === total.toFixed(2);

  const childrenOf = (pid: string | null) => c.milestones.filter((m) => m.parent_id === pid);

  const renderNode = (node: MilestoneNode): JSX.Element => (
    <div className={styles.node} key={node.id} style={{ marginLeft: node.depth * 16 }}>
      <div className={styles.nodeHead}>
        <Icon name={node.kind === 'branch' ? 'stages' : 'milestone'} size={20} />
        <input
          className={styles.nodeTitleInput}
          defaultValue={node.title}
          disabled={!editable}
          aria-label={t('contract.nodeTitle')}
          key={`t-${node.id}-${node.title}`}
          onBlur={(e) => {
            if (editable && e.target.value.trim() && e.target.value !== node.title) {
              void run(() => api.patch(`/milestones/${node.id}`, { title: e.target.value.trim() }));
            }
          }}
        />
        {node.kind === 'leaf' ? (
          <input
            className={styles.amountInput}
            defaultValue={node.amount?.amount ?? '0.00'}
            inputMode="decimal"
            disabled={!editable}
            aria-label={t('contract.nodeAmount')}
            key={`a-${node.id}-${node.amount?.amount}`}
            onBlur={(e) => {
              if (editable && e.target.value !== node.amount?.amount) {
                void run(() => api.patch(`/milestones/${node.id}`, { amount: e.target.value }));
              }
            }}
          />
        ) : (
          <Badge tone="neutral">{t('contract.branch')}</Badge>
        )}
      </div>

      {editable && (
        <div className={styles.nodeMeta}>
          <button className={styles.iconBtn} onClick={() => void run(() => api.post('/milestones', { parent_id: node.id, title: t('contract.newLeafTitle'), kind: 'leaf', amount: '0.00' }))}>
            <Icon name="plus" size={16} /> {t('contract.addLeaf')}
          </button>
          {/* Добавление веток скрыто (отсмотр 2026-08-20): мастер v1 их не
              создаёт, плоский список этапов понятнее. */}
          {node.parent_id !== null && (
            <button className={styles.iconBtn} onClick={() => void run(() => api.del(`/milestones/${node.id}`))}>
              <Icon name="close" size={16} /> {t('contract.remove')}
            </button>
          )}
        </div>
      )}

      {node.kind === 'leaf' && (
        <>
          {node.checklist_items.length > 0 && (
            <ul className={styles.checklist}>
              {node.checklist_items.map((ci) => (
                <li key={ci.id}>
                  <Icon name="checklist" size={16} /> {ci.text}
                  {ci.required_evidence ? <Badge tone="teal">{t('contract.requiredEvidence')}</Badge> : null}
                </li>
              ))}
            </ul>
          )}
          {node.materials.map((m) => (
            <div className={styles.material} key={m.id}>
              <Icon name="wallet" size={16} /> {m.title || m.catalog_ref}: {m.description}
              {m.price ? (
                <>
                  {' · '}
                  <LtrText as="span">{formatMoney(m.price)}</LtrText>
                </>
              ) : null}
            </div>
          ))}
          {/* Добавления критериев тут нет: легаси-ветка (не-`rc-`) жила на своём
              вложенном мок-эндпоинте `POST /contracts/{id}/milestones/{msId}/
              checklist-items` с телом `{ text }`, которого на бэке не существует
              (реальный — плоский `/milestones/{id}/checklist-items` с
              `{ description, measurable_criterion, … }`). В не-мок-режиме
              `isRealContractId` всегда true, так что до реального API этот путь
              дойти не мог; удалён как мёртвый (хвосты 2026-08-25). Добавление
              критериев живёт в реальной ветке — `RealMilestoneNode`. */}
          {editable && <MaterialAdd onAdd={(body) => run(() => api.post(`/milestones/${node.id}/materials`, body))} />}
        </>
      )}

      {childrenOf(node.id).map(renderNode)}
    </div>
  );

  return (
    <div className={styles.panel}>
      {!editable && <Callout tone="neutral">{t('contract.editLocked')}</Callout>}
      {err ? <Callout tone="warn">{err}</Callout> : null}
      {childrenOf(null).map(renderNode)}
      <div className={styles.card}>
        <div className={styles.rowBetween}>
          <span>{t('contract.leafSum')}</span>
          <strong>
            <LtrText as="span">{formatMoney({ amount: leafSum.toFixed(2), currency: c.total.currency })}</LtrText>
          </strong>
        </div>
        <div className={styles.rowBetween}>
          <span>{t('contract.total2')}</span>
          <strong>
            <LtrText as="span">{formatMoney(c.total)}</LtrText>
          </strong>
        </div>
        <Badge tone={match ? 'green' : 'red'} dot>
          {match ? t('contract.sumMatch') : t('contract.sumMismatch')}
        </Badge>
      </div>
    </div>
  );
}

// TODO(Ф2): подключить рекомендации чек-листа по материалам —
// эндпоинт GET /checklist-recommendations (web/src/mocks/contractHandlers.ts) уже есть,
// но UI его не вызывает. Ожидается: при добавлении материала предлагать готовые
// пункты приёмки из checklistRecommendations по категории материала (§8.5, скоуп Ф2 п.2).
function ChecklistAdd({
  onAdd,
  suggestions,
}: {
  /** Сохранить набранные критерии (по одному POST на пункт). Признак «нужно
   * доказательство» приходит вместе с текстом: новый пункт создаётся БЕЗ него
   * (решение владельца 05.09), включается переключателем на строке. */
  onAdd: (items: ChecklistDraftItem[]) => Promise<unknown> | void;
  suggestions?: string[];
}): JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ChecklistDraftItem[]>([]);
  const [saving, setSaving] = useState(false);
  let seq = 0;
  const nid = () => `cl-${Date.now()}-${seq++}`;

  function close(): void {
    setOpen(false);
    setItems([]);
  }

  async function save(): Promise<void> {
    setSaving(true);
    try {
      await onAdd(items);
      close();
    } finally {
      setSaving(false);
    }
  }

  // Отсмотр 2026-08-20: «крестик» рядом с полем не открывал никакого окна —
  // теперь критерии набираются в окне с явной кнопкой «Сохранить».
  return (
    <>
      <div className={styles.inlineAdd}>
        <button type="button" className={styles.iconBtn} onClick={() => setOpen(true)} data-testid="checklist-add-open">
          <Icon name="plus" size={16} /> {t('contract.addChecklist')}
        </button>
      </div>
      <Sheet
        open={open}
        title={t('contract.addChecklist')}
        onClose={close}
        closeLabel={t('common.close')}
        actions={
          <>
            <Button variant="ghost" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={items.length === 0 || saving} data-testid="checklist-add-save">
              {t('contract.save')}
            </Button>
          </>
        }
      >
        <ChecklistEditor
          items={items}
          onAdd={(text) => setItems((prev) => [...prev, { id: nid(), text, requiredEvidence: false }])}
          onDelete={(id) => setItems((prev) => prev.filter((it) => it.id !== id))}
          onToggleEvidence={(id, requiredEvidence) =>
            setItems((prev) => prev.map((it) => (it.id === id ? { ...it, requiredEvidence } : it)))
          }
          suggestions={suggestions}
          labels={{
            addPlaceholder: t('contractNew.checklist.addPlaceholder'),
            addLabel: t('contractNew.checklist.addLabel'),
            requiredLabel: t('contractNew.checklist.requiredLabel'),
            emptyWarning: t('contractNew.checklist.emptyWarning'),
            deleteAria: t('contractNew.checklist.deleteAria'),
            suggestionsTitle: t('contractNew.checklist.suggestionsTitle'),
            suggestionAddAria: t('contractNew.checklist.suggestionAddAria'),
            formatShowAll: (count) => t('contractNew.checklist.showAll', { count }),
            showLess: t('contractNew.checklist.showLess'),
            noMatchHint: t('contractNew.checklist.noMatchHint'),
          }}
        />
      </Sheet>
    </>
  );
}

// Коды категорий материала стабильны между языками (значение `<select>` и `catalog_ref`);
// человекочитаемая метка — только для отображения и итогового `title` (i18n-ключ ниже).
const MATERIAL_CATEGORIES = [
  { code: 'tile', key: 'contract.materialCategoryTile' },
  { code: 'laminate', key: 'contract.materialCategoryLaminate' },
  { code: 'wallpaper', key: 'contract.materialCategoryWallpaper' },
  { code: 'other', key: 'contract.materialCategoryOther' },
] as const;

function MaterialAdd({ onAdd }: { onAdd: (body: Record<string, unknown>) => Promise<unknown> }): JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [cat, setCat] = useState<(typeof MATERIAL_CATEGORIES)[number]['code']>('other');
  const [desc, setDesc] = useState('');
  const [priceBy, setPriceBy] = useState<'customer' | 'contractor'>('customer');
  const [price, setPrice] = useState('');
  const [err, setErr] = useState<string | null>(null);

  return (
    <>
      <div className={styles.inlineAdd}>
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          <Icon name="plus" size={16} /> {t('contract.addMaterial')}
        </Button>
      </div>
      <Modal
        open={open}
        title={t('contract.addMaterial')}
        onClose={() => setOpen(false)}
        closeLabel={t('common.close')}
        actions={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setErr(null);
                onAdd({
                  catalog_ref: cat,
                  title: t(MATERIAL_CATEGORIES.find((c) => c.code === cat)?.key ?? 'contract.materialCategoryOther'),
                  description: desc,
                  price_by: priceBy,
                  price: price || undefined,
                  delivery_days_from_event: 3,
                })
                  .then(() => {
                    setOpen(false);
                    setDesc('');
                    setPrice('');
                  })
                  .catch((e) => setErr(e instanceof ApiError ? e.message : String(e)));
              }}
            >
              {t('contract.save')}
            </Button>
          </>
        }
      >
        <div style={{ display: 'grid', gap: 12 }}>
          <label className={styles.viewAsLabel}>{t('contract.materialsTitle')}</label>
          <SelectField
            value={cat}
            onChange={(e) => setCat(e.target.value as (typeof MATERIAL_CATEGORIES)[number]['code'])}
            aria-label={t('contract.materialCategoryAria')}
          >
            {MATERIAL_CATEGORIES.map((c) => (
              <option key={c.code} value={c.code}>
                {t(c.key)}
              </option>
            ))}
          </SelectField>
          <TextField label={t('contract.materialDescLabel')} value={desc} onChange={(e) => setDesc(e.target.value)} />
          <div className={styles.segmented}>
            <button type="button" className={`${styles.segBtn} ${priceBy === 'customer' ? styles.segBtnActive : ''}`} onClick={() => setPriceBy('customer')}>
              {t('contract.roleCustomer')}
            </button>
            <button type="button" className={`${styles.segBtn} ${priceBy === 'contractor' ? styles.segBtnActive : ''}`} onClick={() => setPriceBy('contractor')}>
              {t('contract.roleContractor')}
            </button>
          </div>
          <TextField label={t('contract.materialPriceLabel')} value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
          {err ? <Callout tone="warn">{err}</Callout> : null}
        </div>
      </Modal>
    </>
  );
}

// ─────────────────────────────────────────── Согласование
function NegoPanel({ c }: { c: ContractDetail }): JSX.Element {
  const { t } = useTranslation();
  const api = useContractApi(c.id);
  const viewAs = useViewerStore((s) => s.viewAs);
  const [err, setErr] = useState<string | null>(null);
  const [proposeOpen, setProposeOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ item_label: string; before: string; after: string }[] | null>(null);

  const run = (fn: () => Promise<unknown>) => fn().catch((e) => setErr(e instanceof ApiError ? e.message : String(e)));

  async function acceptAll(): Promise<void> {
    try {
      await api.post('/revisions/accept-all', { confirm_summary: false });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'confirm_summary_required') {
        setConfirm((e.problem.changes as { item_label: string; before: string; after: string }[]) ?? []);
        return;
      }
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }

  const open = c.revisions.filter((r) => r.status === 'open');

  return (
    <div className={styles.panel}>
      <div className={styles.rowBetween}>
        <h3 className={styles.sectionTitle}>{t('contract.negoTitle')}</h3>
        <div className={styles.actions}>
          <Button variant="ghost" onClick={() => setProposeOpen(true)} data-testid="propose-revision">
            {t('contract.proposeRevision')}
          </Button>
          {open.length > 0 && (
            <Button variant="secondary" onClick={acceptAll} data-testid="accept-all">
              {t('contract.acceptAll')}
            </Button>
          )}
        </div>
      </div>

      {err ? <Callout tone="warn">{err}</Callout> : null}

      {c.revisions.length === 0 && c.preapproved_alternatives.length === 0 ? (
        <Callout tone="neutral">{t('contract.negoEmpty')}</Callout>
      ) : null}

      {c.revisions.map((r) => (
        <div className={styles.revision} key={r.id}>
          <div className={styles.rowBetween}>
            <strong>{r.item_label}</strong>
            {/* DEV-10 добавил статусы countered/withdrawn (§2) — используем общий review.status* словарь. */}
            <Badge tone={r.status === 'open' ? 'amber' : r.status === 'accepted' ? 'green' : 'neutral'}>
              {t(`review.status${r.status === 'open' ? 'Open' : r.status === 'accepted' ? 'Accepted' : r.status === 'rejected' ? 'Rejected' : r.status === 'countered' ? 'Countered' : 'Withdrawn'}`)}
            </Badge>
          </div>
          <div className={styles.change}>
            <span className={styles.before}>{r.before}</span> → <span className={styles.after}>{r.after}</span>
          </div>
          {r.comment ? <div className={styles.handle}>{r.comment}</div> : null}
          {r.financially_material ? <Badge tone="amber">{t('contract.financiallyMaterial')}</Badge> : null}
          {r.status === 'open' && viewAs !== r.author_role && (
            <div className={styles.actions}>
              <Button size="sm" variant="secondary" onClick={() => void run(() => api.post(`/revisions/${r.id}/respond`, { action: 'accept' }))}>
                {t('contract.accept')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void run(() => api.post(`/revisions/${r.id}/respond`, { action: 'reject' }))}>
                {t('contract.rejectRevision')}
              </Button>
            </div>
          )}
        </div>
      ))}

      {c.preapproved_alternatives.length > 0 && (
        <div className={styles.card}>
          <h3 className={styles.sectionTitle}>{t('contract.preapprovedTitle')}</h3>
          {c.preapproved_alternatives.map((a) => (
            <div className={styles.rowBetween} key={a.id}>
              <span>
                {a.item_label}: <span className={styles.before}>{a.before}</span> → <span className={styles.after}>{a.after}</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => void run(() => api.post(`/preapproved-alternatives/${a.id}/apply`))}>
                {t('contract.applyAlt')}
              </Button>
            </div>
          ))}
        </div>
      )}

      <ProposeModal open={proposeOpen} onClose={() => setProposeOpen(false)} onSubmit={(body) => run(() => api.post('/revisions', body))} />

      <Modal
        open={!!confirm}
        title={t('contract.confirmSummaryTitle')}
        onClose={() => setConfirm(null)}
        closeLabel={t('common.close')}
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              data-testid="confirm-accept-all"
              onClick={() => {
                setConfirm(null);
                void run(() => api.post('/revisions/accept-all', { confirm_summary: true }));
              }}
            >
              {t('contract.confirm')}
            </Button>
          </>
        }
      >
        <p>{t('contract.confirmSummaryText')}</p>
        <div className={styles.confirmList}>
          {confirm?.map((ch, i) => (
            <div className={styles.change} key={i}>
              {ch.item_label}: <span className={styles.before}>{ch.before}</span> → <span className={styles.after}>{ch.after}</span>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}

function ProposeModal({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<unknown>;
}): JSX.Element {
  const { t } = useTranslation();
  const [label, setLabel] = useState('');
  const [before, setBefore] = useState('');
  const [after, setAfter] = useState('');
  const [comment, setComment] = useState('');
  const [material, setMaterial] = useState(false);
  return (
    <Modal
      open={open}
      title={t('contract.proposeRevision')}
      onClose={onClose}
      closeLabel={t('common.close')}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            data-testid="submit-revision"
            onClick={() => {
              void onSubmit({
                item_ref: 'term:custom',
                item_label: label || t('contract.customTermDefaultLabel'),
                before,
                after,
                comment,
                financially_material: material,
              }).then(onClose);
            }}
          >
            {t('contract.proposeRevision')}
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <TextField label={t('contract.revisionItem')} value={label} onChange={(e) => setLabel(e.target.value)} />
        <TextField label={t('contract.revisionBefore')} value={before} onChange={(e) => setBefore(e.target.value)} />
        <TextField label={t('contract.revisionAfter')} value={after} onChange={(e) => setAfter(e.target.value)} />
        <TextField label={t('contract.revisionComment')} value={comment} onChange={(e) => setComment(e.target.value)} />
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={material} onChange={(e) => setMaterial(e.target.checked)} />
          {t('contract.financiallyMaterial')}
        </label>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────── Подписание
function SignPanel({ c }: { c: ContractDetail }): JSX.Element {
  const { t } = useTranslation();
  const { formatDateTime } = useFormatters();
  const navigate = useNavigate();
  const api = useContractApi(c.id);
  const viewAs = useViewerStore((s) => s.viewAs);
  const addPayout = useAddPayout();
  const { data: payouts } = usePayoutAccounts();
  const [err, setErr] = useState<string | null>(null);
  const paid = hasContractFee(c.segment);

  const run = (fn: () => Promise<unknown>, onErr?: (e: ApiError) => void) =>
    fn().catch((e) => {
      if (e instanceof ApiError) {
        if (onErr) onErr(e);
        else setErr(e.message);
      } else setErr(String(e));
    });

  async function freeze(): Promise<void> {
    setErr(null);
    await run(
      () => api.post('/freeze'),
      (e) => {
        if (e.code === 'requisites_missing') setErr(t('contract.errRequisites'));
        else if (e.code === 'open_revisions') setErr(t('contract.errOpenRevisions'));
        else if (e.code === 'leaf_sum_mismatch') setErr(t('contract.errLeafMismatch'));
        else setErr(e.message);
      },
    );
  }

  async function addRequisites(): Promise<void> {
    const acc = await addPayout.mutateAsync({ kind: 'sbp', masked: '•••• 4321' });
    await api.post('/payout-account', { account_id: acc.id });
  }

  async function sign(role: RevisionAuthorRole): Promise<void> {
    setErr(null);
    await run(
      () => api.post('/sign'),
      (e) => {
        if (e.code === 'ai_summary_not_shown') setErr(t('contract.needAiSummary'));
        else setErr(e.message);
      },
    );
    void role;
  }

  if (c.status === 'signed') {
    return (
      <div className={styles.panel}>
        <div className={styles.signedBanner}>
          {/* Подтверждающий момент — знак, вспышка в нём самом (DEV-17 §3). */}
          <span role="img" aria-label={t('contract.signedBanner')}>
            <Logo variant="mark" size={96} />
          </span>
          <h3 className={styles.sectionTitle}>{t('contract.signedBanner')}</h3>
        </div>
      </div>
    );
  }

  const editableStill = isEditable(c.status);
  const hasPayout = (payouts?.length ?? 0) > 0 && !!c.payout_account_id;
  const signedCustomer = c.signatures.some((s) => s.role === 'customer');
  const signedContractor = c.signatures.some((s) => s.role === 'contractor');

  return (
    <div className={styles.panel}>
      {err ? <Callout tone="warn">{err}</Callout> : null}

      {/* Заморозка */}
      {editableStill && (
        <div className={styles.card}>
          <h3 className={styles.sectionTitle}>{t('contract.freeze')}</h3>
          <p className={styles.handle}>{t('contract.freezeHint')}</p>
          {paid && !hasPayout && (
            <Callout tone="warn" title={t('contract.payoutTitle')}>
              {t('contract.payoutMissing')}
              <div style={{ marginTop: 8 }}>
                <Button size="sm" variant="secondary" onClick={() => void run(addRequisites)} loading={addPayout.isPending} data-testid="add-payout">
                  {t('contract.addPayout')}
                </Button>
              </div>
            </Callout>
          )}
          <div className={styles.actions}>
            <Button variant="primary" onClick={freeze} data-testid="freeze">
              {t('contract.freeze')}
            </Button>
          </div>
        </div>
      )}

      {/* Версия + резюме + комиссия + подписи */}
      {c.version && (
        <>
          <div className={styles.actions}>
            <Button variant="teal" onClick={() => navigate(`/contracts/${c.id}/sign`)} data-testid="go-to-signing-screen">
              {t('contract.goToSigning')}
            </Button>
          </div>

          <div className={styles.card}>
            <h3 className={styles.sectionTitle}>{t('contract.versionTitle')}</h3>
            <div className={styles.rowBetween}>
              <span>{t('contract.integrityHash')}</span>
              <LtrText as="span" className={styles.handle} data-testid="integrity-hash">
                {c.version.integrity_hash.slice(0, 18)}…
              </LtrText>
            </div>
            <div className={styles.rowBetween}>
              <span>{t('contract.tsaTime')}</span>
              <LtrText as="span" className={styles.handle}>
                {formatDateTime(c.version.tsa_time, { legal: true })}
              </LtrText>
            </div>
          </div>

          <div className={styles.card}>
            <h3 className={styles.sectionTitle}>{t('contract.aiSummaryTitle')}</h3>
            {c.ai_summary_shown ? (
              <>
                <p>{c.version.ai_summary}</p>
                <Badge tone="green" dot>
                  {t('contract.aiSummaryShown')}
                </Badge>
              </>
            ) : (
              <Button variant="secondary" onClick={() => void run(() => api.post('/ai-summary-shown'))} data-testid="show-ai-summary">
                {t('contract.aiSummaryShow')}
              </Button>
            )}
          </div>

          {/* Финмодель v2: комиссии за заключение нет — заключение договора бесплатно (ADR-032, единый источник копирайта). */}
          <PaymentPolicyLine
            title={t(c.payment_policy.contractFee.labelKey)}
            note={t(c.payment_policy.contractFee.noteKey)}
            positive={!c.payment_policy.contractFee.applies}
          />

          {/* Подписи */}
          <div className={styles.card}>
            <h3 className={styles.sectionTitle}>{t('contract.signTitle')}</h3>
            {c.status === 'pending_signature' && (
              <div className={styles.actions}>
                <Button variant="secondary" onClick={() => void run(() => api.post('/signature-requests'))} data-testid="request-signatures">
                  {t('contract.requestSignatures')}
                </Button>
              </div>
            )}
            {c.status === 'awaiting_signatures' && (
              <>
                <div className={styles.rowBetween}>
                  <Badge tone={signedCustomer ? 'green' : 'neutral'} dot>
                    {signedCustomer ? t('contract.signedByCustomer') : t('contract.roleCustomer')}
                  </Badge>
                  <Badge tone={signedContractor ? 'green' : 'neutral'} dot>
                    {signedContractor ? t('contract.signedByContractor') : t('contract.roleContractor')}
                  </Badge>
                </div>
                <div className={styles.actions}>
                  {viewAs === 'customer' && !signedCustomer && (
                    <Button variant="primary" onClick={() => void sign('customer')} data-testid="sign-customer" disabled={!c.ai_summary_shown}>
                      {t('contract.signAsCustomer')}
                    </Button>
                  )}
                  {viewAs === 'contractor' && !signedContractor && (
                    <Button variant="primary" onClick={() => void sign('contractor')} data-testid="sign-contractor" disabled={!c.ai_summary_shown}>
                      {t('contract.signAsContractor')}
                    </Button>
                  )}
                  <Button variant="ghost" onClick={() => void run(() => api.post('/decline'))} data-testid="decline">
                    {t('contract.declineForRevision')}
                  </Button>
                </div>
                {!c.ai_summary_shown ? <p className={styles.handle}>{t('contract.needAiSummary')}</p> : null}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────── История
function TimelinePanel({ id }: { id: string }): JSX.Element {
  const { t } = useTranslation();
  const { formatDateTime } = useFormatters();
  const { data: events } = useTimeline(id);
  return (
    <div className={styles.panel}>
      <h3 className={styles.sectionTitle}>{t('contract.timelineTitle')}</h3>
      <div className={styles.timeline} data-testid="timeline">
        {events?.map((e) => (
          <div className={styles.tlItem} key={e.id}>
            <span className={styles.tlTime}>{formatDateTime(e.at)}</span>
            <span>{e.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════ Реальный контур (ADR-088, Фаза 1) ═══

function RealContractDetail({ id }: { id: string }): JSX.Element {
  const { t } = useTranslation();
  const { formatMoney, formatShortDate } = useFormatters();
  const navigate = useNavigate();
  const isDesktop = useDesktopLayout();
  const { data, isPending, error, refetch } = useRealContractView(id);
  const [tab, setTab] = useState('overview');
  const [err, setErr] = useState<string | null>(null);
  // Какой жест выхода из сделки подтверждаем (ADR-124): отзыв инициатора или
  // отклонение второй стороной. `null` — модалка закрыта.
  const [confirmClose, setConfirmClose] = useState<'withdraw' | 'reject' | null>(null);
  /**
   * Замечание владельца 03.09: «пропала кнопка редактирования в договоре …
   * „предложить правку“ надо продублировать в „обзор“ сразу под „Перейти к
   * подписанию“, иначе не найдут». Кнопка в «Обзоре» переключает на вкладку
   * согласования и просит её открыть модалку — счётчик, а не булев флаг:
   * повторное нажатие должно открывать окно снова, даже если его закрыли.
   */
  const [proposeRequest, setProposeRequest] = useState(0);

  const send = useSendRealContract(id);
  const withdraw = useWithdrawRealContract(id);
  const reject = useRejectRealContract(id);
  // хук — ДО ранних return (правила хуков)
  const myProfileId = useActorStore((s) => s.activeProfileId);
  // Переписка по договору (ADR-112/116): вход из карточки — кнопка в паспорте
  // и вкладка «Чат». Непрочитанное берём из общего кэша списка диалогов
  // (тот же поллинг 10 с, что и бейдж в оболочке) — отдельного запроса нет.
  const chatEnabled = isFeatureEnabled('chat');
  const { data: chatThreads } = useChatThreads(chatEnabled);
  // Только id, без `useCurrentUser`: тот зеркалит профили в актёр-стор и
  // переопределил бы выбранного актёра (см. докстринг `useCurrentUserId`).
  const myUserId = useCurrentUserId();
  // Сторона смотрящего нужна ДО ранних return'ов — от неё зависит хук бейджа.
  const myParty = data?.contract.parties.find((p) => p.profile_id === myProfileId) ?? null;
  /**
   * ADR-156/157: контрагент правил материалы на согласовании. Факт берём из
   * ХРОНИКИ договора (она уже загружена), а не из ленты уведомлений —
   * обоснование в `materialsChanged.ts`.
   */
  const materialsChanged = useMaterialsChangedBadge({
    contractId: id,
    events: data?.timeline,
    negotiationStatus: data?.contract.negotiation_status ?? 'draft',
    viewerKey: myProfileId,
    viewerUserId: myUserId,
    viewerRole: myParty?.role ?? null,
    serverSeenAt: data?.contract.materials_seen_at ?? null,
  });
  // Вкладка «Допсоглашения» (ADR-161 §1) — только у ПОДПИСАННОГО договора:
  // допник к неподписанному невозможен (`contract_not_signed`), до подписания
  // те же изменения идут протоколом разногласий. Счётчик — незакрытые допники.
  // Хук — ДО ранних return'ов (правила хуков), поэтому статус берём из `data?`.
  const amendmentsVisible = data?.contract.negotiation_status === 'signed';
  const amendmentsQ = useContractAmendments(id, amendmentsVisible);
  const openAmendments = (amendmentsQ.data ?? []).filter(isOpenAmendment).length;
  // ADR-170: уведомление открывает РАЗДЕЛ, о котором пришло. Бэк отдаёт его
  // якорем в `action.href` пункта ленты (та же строка — в пуше и в письме),
  // разбор — общей таблицей в `cardDeepLink`. Доступность условных вкладок
  // считается здесь: «Чат» — по второй стороне, «Допники» — по подписанию.
  const hash = useLocation().hash;
  const hasChatTab = chatEnabled && (data?.contract.parties.length ?? 0) >= 2;
  useEffect(() => {
    const target = contractTabFromHash(hash, { chat: hasChatTab, amendments: amendmentsVisible });
    if (target) setTab(target);
  }, [hash, hasChatTab, amendmentsVisible]);

  if (isPending) {
    return (
      <div className={styles.wrap}>
        <Skeleton width="50%" height={30} />
        <Skeleton width="100%" height={200} />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className={styles.wrap}>
        <ErrorState title={t('contract.card.errorText')} retryLabel={t('common.retry')} onRetry={() => void refetch()} />
      </div>
    );
  }

  const { contract } = data;
  const status = realCardStatus(contract);
  const muted = MUTED_STATUSES.includes(status);
  // Чат есть у любого договора с двумя сторонами, включая черновик (ADR-116).
  const hasChat = chatEnabled && contract.parties.length >= 2;
  const chatUnread = chatThreads?.find((th) => th.contract_id === id)?.unread_count ?? 0;
  const openChat = () => navigate(`/chat/${id}`);

  /**
   * Вкладки карточки в порядке важности. Замечание владельца 07.09: за
   * воронкой их не находят, поэтому в полосе стоят ВСЕ — на узком экране в
   * несколько рядов (`showAll`). Порядок = приоритет: что важнее, то в первом
   * ряду.
   */
  const cardTabs: ScreenTabItem[] = [
    { key: 'overview', label: t('contract.tabs.overview') },
    { key: 'terms', label: t('contract.tabs.terms') },
    { key: 'stages', label: t('contract.tabs.stages'), count: data.milestones.length },
    { key: 'payments', label: t('contract.tabs.payments') },
    ...(hasChat ? [{ key: 'chat', label: t('contract.tabs.chat'), count: chatUnread }] : []),
    { key: 'negoSign', label: t('contract.tabs.negoSign'), count: data.revisions.filter((r) => r.status === 'open').length },
    ...(amendmentsVisible ? [{ key: 'amendments', label: t('contract.tabs.amendments'), count: openAmendments }] : []),
    { key: 'timeline', label: t('contract.tabs.timeline') },
  ];

  // Отсмотр 2026-08-19: сырой contract_type_code в шапке не показываем —
  // семейство кода маплится на локализованные плитки мастера (как в списке,
  // RealContractRow); неизвестный сегмент — без бейджа, не литерал ключа.
  const typeLabelKey = contractTypeLabelKey(contract.contract_type_code);
  const segmentLabel = t(`segment.${contract.segment}`, { defaultValue: '' });

  const canSend = contract.negotiation_status === 'draft' && !!myParty;
  // ADR-124: выйти из сделки можно не только с согласования, но и из заморозки
  // (`pending_signature`/`awaiting_signatures`) — бэк аннулирует заявки и
  // подписи раунда и снимает `frozen_version`. Роли прежние: отзывает
  // инициатор (`withdraw`), отклоняет вторая сторона (`reject`).
  const closable =
    contract.negotiation_status === 'under_review'
    || contract.negotiation_status === 'pending_signature'
    || contract.negotiation_status === 'awaiting_signatures';
  const canWithdraw = closable && myParty?.role === contract.initiator_role;
  // «Предложить правку» — то же условие, что у кнопки в блоке согласования.
  const canProposeRevision = contract.negotiation_status === 'under_review' && !!myParty;
  const canClaimWarranty = contract.execution_status === 'warranty' && myParty?.role === 'customer';
  const canReject = closable && !!myParty && myParty.role !== contract.initiator_role;

  const busy = (fn: () => Promise<unknown>) => () => {
    setErr(null);
    void fn().catch((e) => setErr(e instanceof ApiError ? e.message : String(e)));
  };

  /** Подтверждённый выход из сделки: из заморозки он ещё и аннулирует раунд
   * подписания, поэтому спрашиваем — как на экране подписания. Ошибку кладём
   * в общий баннер карточки и модалку закрываем в любом исходе. */
  async function onConfirmClose(): Promise<void> {
    if (!confirmClose) return;
    setErr(null);
    try {
      await (confirmClose === 'withdraw' ? withdraw.mutateAsync() : reject.mutateAsync());
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setConfirmClose(null);
    }
  }

  const overviewLeaves = leavesOf(data.milestones);
  const doneLeaves = overviewLeaves.filter((m) => DONE_MILESTONE_STATUSES.includes(m.status));
  const acceptedTotal: MoneyLike | null = contract.total
    ? { amount: doneLeaves.reduce((acc, m) => acc + Number(m.amount ?? 0), 0).toFixed(2), currency: contract.total.currency }
    : null;
  const progressPct = overviewLeaves.length > 0 ? Math.round((doneLeaves.length / overviewLeaves.length) * 100) : undefined;
  const signed = contract.negotiation_status === 'signed';
  // Этап, который ждёт действия (доска B «Карточка договора»): на приёмке —
  // «Открыть приёмку», иначе текущий — «Открыть этап». Один CTA, не список.
  const acceptanceLeaf = overviewLeaves.find((m) => m.status === 'under_acceptance');
  const currentLeaf = acceptanceLeaf ?? overviewLeaves.find((m) => CURRENT_MILESTONE_STATUSES.includes(m.status));
  const counterparty = contract.parties.find((p) => p.profile_id !== myProfileId) ?? null;
  const roleLabel = (role: 'customer' | 'contractor'): string =>
    t(role === 'customer' ? 'contract.roleCustomer' : 'contract.roleContractor');
  const payLabel = contract.payment_method ? t(PAY_LABEL_KEY[contract.payment_method]) : t('contracts.payNone');
  const typeLabel = typeLabelKey ? t(typeLabelKey) : segmentLabel;

  /**
   * CTA сделки (DEV-20_2 §5/§7): одно главное действие во всю ширину, вторичные
   * — outline в ряд, «Отозвать/Отклонить» — красным текстом. Набор один на
   * телефон и десктоп; `ink` — outline на тёмном паспорт-рейле.
   */
  function primaryAction(): ReactNode {
    if (canSend) {
      return (
        <Button variant="primary" block onClick={busy(() => send.mutateAsync())} loading={send.isPending} data-testid="send-contract">
          {t('contract.send')}
        </Button>
      );
    }
    if (!signed && !muted) {
      return (
        <Button variant="primary" block onClick={() => navigate(`/contracts/${id}/sign`)} data-testid="go-to-signing-screen">
          {t('contract.goToSigning')}
        </Button>
      );
    }
    if (signed && currentLeaf) {
      return (
        <Button variant="primary" block onClick={() => navigate(`/contracts/${id}/stages/${currentLeaf.id}`)} data-testid="open-current-stage">
          {acceptanceLeaf ? t('contract.card.openAcceptance') : t('contract.paymentsTab.openStage')}
        </Button>
      );
    }
    if (canClaimWarranty) return <WarrantyClaimAction contractId={id} block />;
    return null;
  }
  function secondaryActions(ink: boolean): ReactNode[] {
    const outline: 'outline' | 'outline-ink' = ink ? 'outline-ink' : 'outline';
    // Замечание владельца 07.09 («кнопки на мобильном тоже покрасьте»):
    // вторичные действия — цветные, а не одинаковые обводки, на ОБЕИХ
    // раскладках. «Чат» — бирюзовый, «Предложить правку» — заливка, которая не
    // путается с оранжевой primary «Перейти к подписанию»: на тёмном рейле это
    // мягкий янтарь (`spark`), на светлой карточке телефона — тёмная
    // `secondary` (`spark` на кремовом фоне пропадает). Выход из сделки
    // (`quietCloseActions`) сюда НЕ входит — он тихий и стоит последним.
    const revision: 'secondary' | 'spark' = ink ? 'spark' : 'secondary';
    const chat = 'teal';
    const items: ReactNode[] = [];
    // Правка допустима ровно там же, где живёт кнопка в блоке согласования
    // (`RealNegoSignPanel`: `negotiation_status === 'under_review'`,
    // tech-spec §6.1) — второе условие развело бы кнопки по смыслу.
    if (canProposeRevision) {
      items.push(
        <Button
          key="propose-revision"
          variant={revision}
          block
          onClick={() => {
            setTab('negoSign');
            setProposeRequest((n) => n + 1);
          }}
          data-testid="overview-propose-revision"
        >
          {t('contract.proposeRevision')}
        </Button>,
      );
    }
    if (canSend) {
      items.push(
        <Button key="edit" variant={outline} block onClick={() => navigate(draftEditPath(id))} data-testid="edit-draft">
          {t('contracts.draftEdit')}
        </Button>,
        <DeleteDraftButton key="delete" contractId={id} block onDeleted={() => navigate('/contracts', { replace: true })} />,
      );
    }
    if (hasChat) {
      items.push(
        <Button key="chat" variant={chat} block leftIcon={<Icon name="chat" size={16} />} onClick={openChat} data-testid="open-chat">
          {t('contract.tabs.chat')}
        </Button>,
      );
    }
    if (signed && canClaimWarranty && currentLeaf) items.push(<WarrantyClaimAction key="warranty" contractId={id} block />);
    if (signed || muted) {
      items.push(
        <Button key="archive" variant={outline} block leftIcon={<Icon name="share" size={16} />} onClick={() => navigate(`/contracts/${id}/archive`)} data-testid="export-archive">
          {ink ? t('contract.card.exportArchive') : t('contract.card.archiveCta')}
        </Button>,
      );
    }
    return items;
  }

  /**
   * Выход из сделки — «Отозвать» (инициатор) и «Отклонить» (вторая сторона).
   * Решение владельца 07.09: красная ЗАЛИВКА делала отказ от договора похожим
   * на основное действие и ловила случайные нажатия. Теперь это тихая ссылка
   * без заливки и рамки (`variant="link"` + `data-quiet`), обычным кеглем и
   * ПОСЛЕДНЕЙ в списке действий — кто ищет, тот находит. Подтверждение
   * (`confirmClose` → модалка) не тронуто: там кнопка по-прежнему красная.
   */
  function quietCloseActions(): ReactNode[] {
    const items: ReactNode[] = [];
    if (canWithdraw) {
      items.push(
        <Button key="withdraw" variant="link" data-quiet block onClick={() => setConfirmClose('withdraw')} loading={withdraw.isPending} data-testid="withdraw-contract">
          {t('contract.withdraw')}
        </Button>,
      );
    }
    if (canReject) {
      items.push(
        <Button key="reject" variant="link" data-quiet block onClick={() => setConfirmClose('reject')} loading={reject.isPending} data-testid="reject-contract">
          {t('contract.reject')}
        </Button>,
      );
    }
    return items;
  }

  // Паспорт сделки (DEV-19 §4) — липкий рейл десктопной карточки: стороны,
  // защита платежа, способ расчёта, юрисдикция.
  const passportRows: PassportRow[] = [
    ...contract.parties.map((p) => ({
      label: roleLabel(p.role),
      value: (
        <>
          <CounterpartyLink profileId={p.profile_id} showAvatar showHandle={false} data-testid={`party-${p.role}`} />
          {p.profile_id === myProfileId ? ` · ${t('contract.youMarker')}` : ''}
        </>
      ),
    })),
    { label: t('contract.card.protectionLabel'), value: t(contract.protected ? 'contract.card.protectionOn' : 'contract.card.protectionOff') },
    { label: t('contract.card.moneyMethodLabel'), value: payLabel },
    // ADR-151: порядок оплаты рядом со способом; у займа неприменим.
    ...(paymentOrderApplicableForType(contract.contract_type_code)
      ? [
          {
            label: t('contractNew.paymentOrderLabel'),
            value: paymentOrderLabelKey(contract.payment_order)
              ? t(paymentOrderLabelKey(contract.payment_order)!)
              : t('contracts.payOrderNone'),
          },
        ]
      : []),
    { label: t('contract.jurisdictionLabel'), value: contract.jurisdiction },
  ];

  /* Дисклеймер «Платформа — оператор, а не сторона» — Disclosure, свёрнут (§4). */
  const operatorNote = (
    <Callout tone="operator" collapsible title={t('contract.operatorDisclaimer')}>
      {t('contract.operatorDisclaimerText')}
    </Callout>
  );

  /* Сводка этапов «только чтение»: у подписанного — «3 из 5 этапов · 80 000 ₽
     принято» + полоса; до подписания — просто «Этапы». */
  const milestoneList = (
    <MilestoneList
      title={
        signed && overviewLeaves.length > 0
          ? t('contract.card.progressStages', { done: doneLeaves.length, total: overviewLeaves.length })
          : t('contract.tabs.stages')
      }
      items={overviewLeaves.map((m) => {
        const done = DONE_MILESTONE_STATUSES.includes(m.status);
        return {
          id: m.id,
          title: m.title,
          statusLabel:
            done && m.accepted_at
              ? t('contract.card.stageAcceptedOn', { date: formatShortDate(m.accepted_at) })
              : t(MILESTONE_STATUS_KEY[m.status]),
          done,
          current: CURRENT_MILESTONE_STATUSES.includes(m.status),
          amountLabel: m.amount && m.currency ? formatMoney({ amount: m.amount, currency: m.currency }) : undefined,
          onOpen: () => navigate(`/contracts/${id}/stages/${m.id}`),
        };
      })}
      countLabel={
        overviewLeaves.length === 0
          ? undefined
          : signed && acceptedTotal
            ? t('contract.card.acceptedAmount', { amount: formatMoney(acceptedTotal) })
            : `${doneLeaves.length} / ${overviewLeaves.length}`
      }
      progressPct={progressPct}
      nowLabel={t('contract.card.stageNow')}
      emptyText={t('contract.card.stagesEmptyText')}
    />
  );

  /**
   * Бейдж внимания «материалы изменены контрагентом» (ADR-156, фронтовой
   * хвост). Клик = переход к материалам: открываем «Этапы», уводим к якорю
   * изменившегося этапа и гасим бейдж (отметка просмотра уходит на сервер —
   * ADR-158, поэтому переживает смену устройства).
   */
  const openChangedMaterials = (): void => {
    const milestoneId = materialsChanged.milestoneId;
    materialsChanged.markSeen();
    setTab('stages');
    if (milestoneId) {
      window.setTimeout(() => {
        // jsdom не реализует scrollIntoView — прокрутка только там, где она есть.
        document.getElementById(`milestone-${milestoneId}`)?.scrollIntoView?.({ block: 'start' });
      }, 0);
    }
  };
  const materialsBadge = materialsChanged.visible ? (
    <MaterialsChangedBadge
      label={t('contract.materialsChangedBadge')}
      hint={t('contract.materialsChangedHint')}
      onOpen={openChangedMaterials}
    />
  ) : null;

  // Замечание владельца 07.09: воронка над вкладками карточки — плохая
  // навигация («люди не могут найти» «Переговоры», «Чат», «Историю»). Ни на
  // десктопе, ни на телефоне воронки и шита у карточки больше нет: ВСЕ вкладки
  // стоят в полосе, на узком экране — в несколько рядов (`showAll` +
  // `flex-wrap` в ScreenTabs.module.css). Вбок не уезжает ни полоса, ни
  // страница. Воронка остаётся там, где она к месту, — в списках сделок.
  const tabsBar = (
    <ScreenTabs
      active={tab}
      onChange={setTab}
      ariaLabel={contract.title || t('contracts.titleUnset')}
      allowExtra
      showAll
      items={cardTabs}
    />
  );

  /* Вкладки, кроме обзора, — одни на обе раскладки. Условия (§4/§11: «Платформа»
     + «Замечания» свёрнуты, «Смотреть все условия» тёмной) живут в RealTermsPanel. */
  const otherPanels = (
    <>
      {tab === 'terms' && <RealTermsPanel contract={contract} />}

      {tab === 'stages' && <RealStagesPanel contractId={id} milestones={data.milestones} editable={isEditable(contract.negotiation_status)} total={contract.total} />}

      {tab === 'payments' && <RealPaymentsPanel contract={contract} />}

      {tab === 'chat' && hasChat && (
        <div className={styles.panel}>
          <Callout tone="neutral" title={t('contract.chatTab.title')}>
            {t('contract.chatTab.text')}
          </Callout>
          <Button variant="primary" block leftIcon={<Icon name="chat" size={16} />} onClick={openChat} data-testid="chat-tab-open">
            {t('contract.chatTab.open')}
          </Button>
        </div>
      )}

      {tab === 'negoSign' && <RealNegoSignPanel data={data} openProposeRequest={proposeRequest} />}

      {tab === 'amendments' && amendmentsVisible && <RealAmendmentsTab contract={contract} />}

      {tab === 'timeline' && <RealTimelinePanel contractId={id} events={data.timeline} onOpenPayments={() => setTab('payments')} />}
    </>
  );

  const closeModal = (
    /* Подтверждение выхода из сделки — тексты общие с экраном подписания
       (`signing.*`): жест и последствия одни и те же, копирайт один. */
    <Modal
      open={confirmClose !== null}
      title={t(confirmClose === 'withdraw' ? 'signing.withdrawConfirmTitle' : 'signing.rejectConfirmTitle')}
      onClose={() => setConfirmClose(null)}
      closeLabel={t('common.close')}
      actions={
        <>
          <Button variant="ghost" onClick={() => setConfirmClose(null)}>{t('common.cancel')}</Button>
          <Button
            variant="destructive"
            loading={withdraw.isPending || reject.isPending}
            onClick={() => void onConfirmClose()}
            data-testid="close-contract-confirm"
          >
            {t(confirmClose === 'withdraw' ? 'contract.withdraw' : 'contract.reject')}
          </Button>
        </>
      }
    >
      <p>{t(confirmClose === 'withdraw' ? 'signing.withdrawConfirmText' : 'signing.rejectConfirmText')}</p>
    </Modal>
  );

  if (!isDesktop) {
    /* Телефон (доска B): «‹ название · статус» → вкладки → содержимое →
       CTA сразу под ним. Светлая рабочая карточка, без паспорта-плашки. */
    const secondary = secondaryActions(false);
    const quiet = quietCloseActions();
    return (
      <div className={`${styles.wrap} ${cc.stack}`} data-testid="contract-passport" data-surface="light">
        <CardHead
          title={contract.title || t('contracts.titleUnset')}
          status={status}
          statusLabel={t(CARD_STATUS_LABEL_KEY[status] ?? 'contract.card.statusDraft')}
          onBack={() => navigate('/contracts')}
          backLabel={t('contract.card.back')}
        />
        <div className={cc.tabs}>{tabsBar}</div>
        {err ? <Callout tone="warn">{err}</Callout> : null}

        {tab === 'overview' && (
          <div className={cc.stack}>
            {signed ? (
              <CardSummaryRow
                counterpartyId={counterparty?.profile_id ?? null}
                counterpartyRole={counterparty?.role ?? 'customer'}
                counterpartyRoleLabel={roleLabel(counterparty?.role ?? 'customer')}
                youLine={[myParty ? t('contract.card.youRole', { role: roleLabel(myParty.role) }) : '', typeLabel].filter(Boolean).join(' · ')}
                sum={contract.total}
                unsetLabel={t('contracts.amountUnset')}
                protectedLabel={contract.protected ? t('contract.card.protectedChip') : undefined}
                chip={payLabel}
              />
            ) : (
              <div className={cc.section}>
                <PartyRows
                  parties={contract.parties.map((p) => ({
                    profileId: p.profile_id,
                    role: p.role,
                    roleLabel: roleLabel(p.role),
                    isMe: p.profile_id === myProfileId,
                    youLabel: t('contract.youMarker'),
                  }))}
                />
                <CardSum
                  label={t('contract.total')}
                  sum={contract.total}
                  unsetLabel={t('contracts.amountUnset')}
                  chips={<Badge tone="neutral">{`${payLabel} · ${contract.jurisdiction}`}</Badge>}
                />
              </div>
            )}

            {materialsBadge}

            {signed ? milestoneList : operatorNote}

            <CardActions
              primary={primaryAction()}
              secondary={secondary.length > 0 ? secondary : undefined}
              quiet={quiet.length > 0 ? quiet : undefined}
            />

            {signed ? <RealAmendmentsEntry contractId={id} onOpen={() => setTab('amendments')} /> : null}
            {signed ? operatorNote : null}
          </div>
        )}

        {otherPanels}
        {closeModal}
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      {/* DEV-19 §4: `≥1024` — липкий паспорт-рейл + широкое тело со вкладками
          (эталон compact-десктопа блок 3). */}
      <PassportLayout
        passport={
          <ContractPassport
            surface="ink"
            no={contract.id.slice(0, 8)}
            title={contract.title || t('contracts.titleUnset')}
            subtitle={typeLabel || undefined}
            status={status}
            statusLabel={t(CARD_STATUS_LABEL_KEY[status] ?? 'contract.card.statusDraft')}
            rows={passportRows}
            sum={contract.total}
            sumUnsetLabel={contract.total ? undefined : t('contracts.amountUnset')}
            sumNote={
              signed && acceptedTotal && overviewLeaves.length > 0
                ? t('contract.card.progressNote', { done: doneLeaves.length, total: overviewLeaves.length, amount: formatMoney(acceptedTotal) })
                : undefined
            }
            actions={
              <div className={cc.actions}>
                {primaryAction()}
                {secondaryActions(true)}
                {quietCloseActions()}
              </div>
            }
          />
        }
      >
        {tabsBar}

        {err ? <Callout tone="warn">{err}</Callout> : null}

        {tab === 'overview' && (
          <div className={styles.panel}>
            {materialsBadge}
            {milestoneList}
            {amendmentsVisible ? <RealAmendmentsEntry contractId={id} onOpen={() => setTab('amendments')} /> : null}
            {operatorNote}
          </div>
        )}

        {otherPanels}
      </PassportLayout>

      {closeModal}
    </div>
  );
}

// ─────────────────────────────────────────── Этапы (реальные)
function RealStagesPanel({
  contractId,
  milestones,
  editable,
  total,
}: {
  contractId: string;
  milestones: RealMilestoneTreeNode[];
  editable: boolean;
  total: { amount: string; currency: string } | null;
}): JSX.Element {
  const { t } = useTranslation();
  const { formatMoney } = useFormatters();
  const createMilestone = useCreateRealMilestone(contractId);
  const [err, setErr] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>) => void fn().catch((e) => setErr(e instanceof ApiError ? e.message : String(e)));
  // Живая сумма листьев (отсмотр 2026-08-20: «сумма внизу не пересчитывается» —
  // `contract.total` появляется только при заморозке версии, до неё итог
  // считается по дереву, как `apps.milestones.services.total_leaf_amount`).
  const leaves = leavesOf(milestones);
  const leafCurrency = leaves.find((m) => m.currency)?.currency ?? total?.currency ?? 'RUB';
  const leafSum = leaves.reduce((sum, m) => sum + (Number(m.amount ?? 0) || 0), 0);
  const liveTotal = total ?? (leaves.length > 0 ? { amount: leafSum.toFixed(2), currency: leafCurrency } : null);
  const defaultCurrency = leafCurrency;

  return (
    <div className={styles.panel}>
      {!editable && <Callout tone="neutral">{t('contract.editLocked')}</Callout>}
      {err ? <Callout tone="warn">{err}</Callout> : null}
      {milestones.map((node) => (
        <RealMilestoneNode key={node.id} contractId={contractId} node={node} editable={editable} depth={0} currency={defaultCurrency} />
      ))}
      {editable ? (
        <div className={styles.inlineAdd}>
          <button
            className={styles.iconBtn}
            onClick={() =>
              run(() => createMilestone.mutateAsync({ title: t('contract.newLeafTitle'), amount: '0.00', currency: defaultCurrency }))
            }
          >
            <Icon name="plus" size={16} /> {t('contract.addLeaf')}
          </button>
          {/* Добавление веток скрыто (отсмотр 2026-08-20) — плоский список этапов. */}
        </div>
      ) : null}
      <div className={styles.card}>
        <div className={styles.rowBetween}>
          <span>{t('contract.total2')}</span>
          <strong data-testid="stages-live-total">
            <LtrText as="span">{liveTotal ? formatMoney(liveTotal) : t('contracts.amountUnset')}</LtrText>
          </strong>
        </div>
      </div>
    </div>
  );
}

function RealMilestoneNode({
  contractId,
  node,
  editable,
  depth,
  currency,
}: {
  contractId: string;
  node: RealMilestoneTreeNode;
  editable: boolean;
  depth: number;
  /** Валюта сумм договора — материалу нужна пара (сумма, валюта), своей у него нет. */
  currency: string;
}): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const patchMilestone = usePatchRealMilestone(contractId);
  const createMilestone = useCreateRealMilestone(contractId);
  const deleteMilestone = useDeleteRealMilestone(contractId);
  const createChecklistItem = useCreateRealChecklistItem(contractId);
  const { data: checklist } = useRealChecklistItems(node.is_leaf ? node.id : undefined);
  const [err, setErr] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>) => void fn().catch((e) => setErr(e instanceof ApiError ? e.message : String(e)));

  /** Копия этапа (отсмотр 2026-08-20): POST с теми же полями + его чек-лист. */
  async function copyStage(): Promise<void> {
    const created = (await createMilestone.mutateAsync({
      title: node.title,
      ...(node.parent_id ? { parent_id: node.parent_id } : {}),
      ...(node.amount && node.currency ? { amount: node.amount, currency: node.currency } : {}),
      ...(node.sphere_code ? { sphere_code: node.sphere_code } : {}),
    })) as { id: string };
    for (const [i, ci] of (checklist ?? []).entries()) {
      await createChecklistItem.mutateAsync({
        milestoneId: created.id,
        input: {
          description: ci.description,
          measurable_criterion: ci.measurable_criterion,
          required_evidence: ci.required_evidence,
          order: i,
        },
      });
    }
  }

  function removeStage(): void {
    if ((checklist ?? []).length > 0 && !window.confirm(t('contractNew.stagesBuilder.deleteStageConfirm'))) return;
    run(() => deleteMilestone.mutateAsync(node.id));
  }

  return (
    // Якорь `#milestone-<id>` — цель ссылки из ленты уведомлений о правках
    // материалов (ADR-156 §3: «расстановка id остаётся задачей фронтенда»).
    <div id={`milestone-${node.id}`} className={styles.node} style={{ marginLeft: depth * 16 }}>
      <div className={styles.nodeHead}>
        <Icon name={node.is_leaf ? 'milestone' : 'stages'} size={20} />
        <input
          className={styles.nodeTitleInput}
          defaultValue={node.title}
          disabled={!editable}
          aria-label={t('contract.nodeTitle')}
          key={`t-${node.id}-${node.title}`}
          onBlur={(e) => {
            if (editable && e.target.value.trim() && e.target.value !== node.title) {
              run(() => patchMilestone.mutateAsync({ milestoneId: node.id, input: { title: e.target.value.trim() } }));
            }
          }}
        />
        {node.is_leaf ? (
          <input
            className={styles.amountInput}
            defaultValue={node.amount ?? '0.00'}
            inputMode="decimal"
            disabled={!editable}
            aria-label={t('contract.nodeAmount')}
            key={`a-${node.id}-${node.amount}`}
            onBlur={(e) => {
              const amount = normalizeAmountInput(e.target.value);
              if (editable && amount !== node.amount) {
                run(() => patchMilestone.mutateAsync({ milestoneId: node.id, input: { amount, currency: node.currency ?? 'RUB' } }));
              }
            }}
          />
        ) : (
          <Badge tone="neutral">{t('contract.branch')}</Badge>
        )}
        {editable ? (
          <>
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => run(copyStage)}
              aria-label={t('contractNew.stagesBuilder.copyStageAria')}
              title={t('contractNew.stagesBuilder.copyStageAria')}
              data-testid="stage-copy"
            >
              <Icon name="copy" size={16} />
            </button>
            <button
              type="button"
              className={styles.iconBtn}
              onClick={removeStage}
              aria-label={t('contractNew.stagesBuilder.deleteStageAria')}
              title={t('contractNew.stagesBuilder.deleteStageAria')}
              data-testid="stage-remove"
            >
              <Icon name="close" size={16} />
            </button>
          </>
        ) : null}
        {node.is_leaf && !editable ? (
          // Дашбордная доводка (§E-смоук): с карточки не было НИКАКОГО пути
          // на страницу этапа (сдача/приёмка, ADR-088 Фазы 5–6). Кнопка —
          // только когда дерево уже не редактируется (после заморозки):
          // до неё страница этапа показывает лишь гейт «не подписан».
          <Button
            size="sm"
            variant="ghost"
            onClick={() => navigate(`/contracts/${contractId}/stages/${node.id}`)}
            data-testid="open-stage"
          >
            {t('contract.card.stageOpenLabel')}
          </Button>
        ) : null}
      </div>

      {err ? <Callout tone="warn">{err}</Callout> : null}

      {node.is_leaf ? (
        <>
          {(checklist ?? []).length > 0 ? (
            <ul className={styles.checklist}>
              {(checklist ?? []).map((ci) => (
                <li key={ci.id}>
                  <Icon name="checklist" size={16} /> {ci.description}
                  {ci.required_evidence ? <Badge tone="teal">{t('contract.requiredEvidence')}</Badge> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {editable ? (
            <ChecklistAdd
              onAdd={(added) =>
                run(async () => {
                  const base = (checklist ?? []).length;
                  for (const [i, it] of added.entries()) {
                    await createChecklistItem.mutateAsync({
                      milestoneId: node.id,
                      input: {
                        description: it.text,
                        measurable_criterion: it.text,
                        required_evidence: it.requiredEvidence ? ['photo'] : [],
                        order: base + i,
                      },
                    });
                  }
                })
              }
            />
          ) : null}
          <RealMaterialsBlock
            contractId={contractId}
            milestoneId={node.id}
            sphereCode={node.sphere_code}
            currency={node.currency ?? currency}
            editable={editable}
          />
        </>
      ) : null}

      {node.children.map((child) => (
        <RealMilestoneNode key={child.id} contractId={contractId} node={child} editable={editable} depth={depth + 1} currency={currency} />
      ))}
    </div>
  );
}

// ─────────────────────────────────────────── Переговоры и подписи (только чтение, Фаза 3–4)
function RealNegoSignPanel({
  data,
  openProposeRequest = 0,
}: {
  data: NonNullable<ReturnType<typeof useRealContractView>['data']>;
  /** Счётчик запросов «открой „Предложить правку“» из CTA «Обзора» (замечание 03.09). */
  openProposeRequest?: number;
}): JSX.Element {
  const { t } = useTranslation();
  const { formatDateTime } = useFormatters();
  const { data: me } = useCurrentUser();
  const contract = data.contract;
  // ADR-123: адреса правок (`title`/`form.<key>`/`other`) подписываются теми же
  // словами, что поля в условиях договора; значения — не сырыми кодами.
  const items = useRevisionItems(contract);
  const propose = useProposeRevision(contract.id);
  const acceptOne = useAcceptRevision(contract.id);
  const rejectOne = useRejectRevision(contract.id);
  const counterOne = useCounterRevision(contract.id);
  const acceptAll = useAcceptAllRevisions(contract.id);
  const [err, setErr] = useState<string | null>(null);
  const [proposeOpen, setProposeOpen] = useState(false);
  // 422 `revision_value_invalid`/`revision_item_unknown` — у поля «Стало» внутри
  // модалки, а не общим баннером за ней: иначе текст ошибки не видно.
  const [proposeErr, setProposeErr] = useState<string | null>(null);
  const [counterErr, setCounterErr] = useState<string | null>(null);
  const [counterCtx, setCounterCtx] = useState<{ revisionId: string; itemRef: string } | null>(null);
  const [summary, setSummary] = useState<{ item_ref: string; old_value: unknown; new_value: unknown }[] | null>(null);

  // Запрос из «Обзора»: 0 — экран открыли обычным путём, окно не трогаем.
  useEffect(() => {
    if (openProposeRequest > 0) {
      setProposeErr(null);
      setProposeOpen(true);
    }
  }, [openProposeRequest]);

  const myProfileIds = new Set((me?.profiles ?? []).map((p) => p.id));
  // Правки — только на согласовании (tech-spec §6.1: under_review, включая
  // возврат с подписания через decline_for_revision).
  const negotiable = contract.negotiation_status === 'under_review';
  // Ссылка на подписание имеет смысл только там, где с него есть «вернуть на
  // доработку»: в черновике подписывать нечего, а после подписи и терминалов
  // возврата уже не существует (ADR-124).
  const returnableFromSigning =
    contract.negotiation_status === 'pending_signature' ||
    contract.negotiation_status === 'awaiting_signatures';
  const openFromOther = data.revisions.filter(
    (r) => r.status === 'open' && !myProfileIds.has(r.proposed_by_id),
  );

  const run = (fn: () => Promise<unknown>) => {
    setErr(null);
    return fn().catch((e) => setErr(e instanceof ApiError ? e.message : String(e)));
  };

  async function onAcceptAll(confirm: boolean): Promise<void> {
    setErr(null);
    try {
      await acceptAll.mutateAsync(confirm);
      setSummary(null);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'confirm_summary_required') {
        setSummary(
          (e.problem.context as { summary?: { item_ref: string; old_value: unknown; new_value: unknown }[] })?.summary ?? [],
        );
        return;
      }
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }

  return (
    <div className={styles.panel}>
      <div className={styles.rowBetween}>
        <h3 className={styles.sectionTitle}>{t('contract.negoTitle')}</h3>
        {negotiable ? (
          <div className={styles.actions}>
            <Button variant="ghost" onClick={() => { setProposeErr(null); setProposeOpen(true); }} data-testid="real-propose-revision">
              {t('contract.proposeRevision')}
            </Button>
            {openFromOther.length > 0 ? (
              <Button variant="secondary" loading={acceptAll.isPending} onClick={() => void onAcceptAll(false)} data-testid="real-accept-all">
                {t('contract.acceptAll')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {err ? <Callout tone="warn">{err}</Callout> : null}

      {/*
        Замечание тестера 27.08 «в окне займа нет кнопки „Предложить правку“»: правила
        (tech-spec §6.1) кнопка и не должна быть видна вне `under_review`, но вкладка
        молча оставалась пустой — отсутствие кнопки читалось как поломка. Объясняем
        причину прямо здесь и уводим на экран подписания, где живёт «вернуть на
        доработку» (ADR-124) — единственный вход обратно в правки после заморозки.
      */}
      {!negotiable ? (
        <div data-testid="nego-closed-hint">
          <Callout tone="neutral" title={t('contract.revisionsClosedTitle')}>
            {t('contract.revisionsClosedText')}
            {returnableFromSigning ? (
              <p>
                <Link to={`/contracts/${contract.id}/sign`} data-testid="nego-closed-to-signing">
                  {t('contract.goToSigning')}
                </Link>
              </p>
            ) : null}
          </Callout>
        </div>
      ) : null}

      {data.revisions.length === 0 ? (
        <Callout tone="neutral">{t('contract.realNoRevisions')}</Callout>
      ) : (
        data.revisions.map((r) => {
          const mineProposal = myProfileIds.has(r.proposed_by_id);
          const statusKey =
            r.status === 'open' ? 'Open' : r.status === 'accepted' ? 'Accepted' : r.status === 'rejected' ? 'Rejected' : 'Countered';
          return (
            <div className={styles.revision} key={r.id} data-testid="real-revision">
              <div className={styles.rowBetween}>
                <strong data-testid="real-revision-item-label">{items.labelOf(r.item_ref)}</strong>
                <Badge tone={r.status === 'open' ? 'amber' : r.status === 'accepted' ? 'green' : 'neutral'}>
                  {t(`review.status${statusKey}`)}
                </Badge>
              </div>
              <div className={styles.change}>
                <span className={styles.before}>{items.valueTextOf(r.item_ref, r.old_value)}</span> →{' '}
                <span className={styles.after}>{items.valueTextOf(r.item_ref, r.new_value)}</span>
              </div>
              {r.comment ? <div className={styles.handle}>{r.comment}</div> : null}
              {negotiable && r.status === 'open' && !mineProposal ? (
                <div className={styles.actions}>
                  <Button size="sm" variant="secondary" loading={acceptOne.isPending} onClick={() => void run(() => acceptOne.mutateAsync(r.id))}>
                    {t('contract.accept')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setCounterErr(null); setCounterCtx({ revisionId: r.id, itemRef: r.item_ref }); }}>
                    {t('review.counter')}
                  </Button>
                  <Button size="sm" variant="ghost" loading={rejectOne.isPending} onClick={() => void run(() => rejectOne.mutateAsync(r.id))}>
                    {t('contract.rejectRevision')}
                  </Button>
                </div>
              ) : null}
            </div>
          );
        })
      )}

      <h3 className={styles.sectionTitle}>{t('contract.signTitle')}</h3>
      {data.signatureRequests.length === 0 ? (
        <Callout tone="neutral">{t('contract.realNoSignatureRequests')}</Callout>
      ) : (
        data.signatureRequests.map((sr) => (
          <div className={styles.rowBetween} key={sr.id}>
            <span>
              {t(sr.side === 'customer' ? 'contract.roleCustomer' : 'contract.roleContractor')} · {sr.status}
            </span>
            <LtrText as="span" className={styles.handle}>{formatDateTime(sr.sent_at)}</LtrText>
          </div>
        ))
      )}

      <RealProposeRevisionModal
        open={proposeOpen}
        contract={contract}
        onClose={() => {
          setProposeErr(null);
          setProposeOpen(false);
        }}
        pending={propose.isPending}
        valueError={proposeErr ?? undefined}
        onSubmit={(input) => {
          setProposeErr(null);
          void propose
            .mutateAsync(input)
            .then(() => setProposeOpen(false))
            .catch((e) => setProposeErr(revisionErrorText(e, t)));
        }}
      />

      <RealCounterModal
        ctx={counterCtx}
        itemLabel={counterCtx ? items.labelOf(counterCtx.itemRef) : ''}
        option={counterCtx ? items.byRef.get(counterCtx.itemRef) : undefined}
        onClose={() => {
          setCounterErr(null);
          setCounterCtx(null);
        }}
        pending={counterOne.isPending}
        valueError={counterErr ?? undefined}
        onSubmit={(newValue, comment) => {
          if (!counterCtx) return;
          setCounterErr(null);
          void counterOne
            .mutateAsync({ revisionId: counterCtx.revisionId, new_value: newValue, comment })
            .then(() => setCounterCtx(null))
            .catch((e) => setCounterErr(revisionErrorText(e, t)));
        }}
      />

      <Modal
        open={!!summary}
        title={t('contract.confirmSummaryTitle')}
        onClose={() => setSummary(null)}
        closeLabel={t('common.close')}
        actions={
          <>
            <Button variant="ghost" onClick={() => setSummary(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={acceptAll.isPending} data-testid="real-confirm-accept-all" onClick={() => void onAcceptAll(true)}>
              {t('contract.confirm')}
            </Button>
          </>
        }
      >
        {(summary ?? []).map((row, i) => (
          <div className={styles.change} key={i}>
            <strong>{items.labelOf(row.item_ref)}</strong>:{' '}
            <span className={styles.before}>{items.valueTextOf(row.item_ref, row.old_value)}</span> →{' '}
            <span className={styles.after}>{items.valueTextOf(row.item_ref, row.new_value)}</span>
          </div>
        ))}
      </Modal>
    </div>
  );
}

/**
 * Встречная редакция (ADR-123): то же поле «Стало» по типу, что и в «Предложить
 * правку»; адрес правки унаследован от исходной — менять его нельзя.
 */
function RealCounterModal({
  ctx,
  itemLabel,
  option,
  onClose,
  onSubmit,
  pending,
  valueError,
}: {
  ctx: { revisionId: string; itemRef: string } | null;
  itemLabel: string;
  option: RevisionItemOption | undefined;
  onClose: () => void;
  onSubmit: (newValue: unknown, comment?: string) => void;
  pending: boolean;
  valueError?: string;
}): JSX.Element {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [comment, setComment] = useState('');
  useEffect(() => {
    if (ctx) {
      setValue('');
      setComment('');
    }
  }, [ctx]);
  return (
    <Modal
      open={!!ctx}
      title={`${t('review.counterTitle')}${ctx ? ` — ${itemLabel}` : ''}`}
      onClose={onClose}
      closeLabel={t('common.close')}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={!value.trim()}
            loading={pending}
            onClick={() =>
              onSubmit(
                option && ctx?.itemRef !== 'other' ? coerceRevisionValueForOption(option, value) : value.trim(),
                comment.trim() || undefined,
              )
            }
          >
            {t('review.counter')}
          </Button>
        </>
      }
    >
      <RevisionValueField
        label={t('contract.revisionAfter')}
        type={option?.type ?? 'string'}
        choices={option?.choices ?? null}
        searchable={option?.searchable ?? false}
        value={value}
        onChange={setValue}
        testId="real-counter-value"
        error={valueError}
      />
      <TextField label={t('review.commentLabel')} value={comment} onChange={(e) => setComment(e.target.value)} />
    </Modal>
  );
}

// ─────────────────────────────────────────── История (реальная)
/**
 * Хроника договора (ADR-134). Подписи `title`/`detail` приходят с бэка
 * локализованными — фронт словаря по `kind` НЕ ведёт (решение владельца
 * 26.08); у старого бэка без `title` показываем нейтральное «Событие» и код
 * `kind` мелким моноширинным, не заголовком. События дочерних сущностей
 * (`nested`: этапы, допники, споры, платежи, гарантия) свёрнуты одной группой
 * под собственной лентой договора — на 390px чередование «договор/этап»
 * с отступами читалось хуже, чем одна кнопка с числом; в группе у каждого
 * события — ссылка на сущность по `subject`.
 */
function RealTimelinePanel({
  contractId,
  events,
  onOpenPayments,
}: {
  contractId: string;
  events: import('@porukam/core').RealTimelineEvent[];
  onOpenPayments: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  // Защита от старого ответа: чат в юрзначимую ленту не подмешиваем.
  const visible = events.filter((e) => !isChatEvent(e));
  const own = visible.filter((e) => !isNestedEvent(e));
  const nested = visible.filter(isNestedEvent);
  // Автораскрытие (решение владельца 26.08): собственных событий договора
  // мало (≤ 2), а вложенные есть — прятать их за кнопкой незачем. Клик
  // пользователя (`nestedChoice`) важнее умолчания; умолчание пересчитывается
  // при обновлении ленты.
  const [nestedChoice, setNestedChoice] = useState<boolean | null>(null);
  const nestedOpen = nestedChoice ?? (own.length <= 2 && nested.length >= 1);
  return (
    <div className={styles.panel}>
      <h3 className={styles.sectionTitle}>{t('contract.timelineTitle')}</h3>
      {visible.length === 0 ? <p className={styles.tlEmpty}>{t('contract.timeline.empty')}</p> : null}
      <div className={styles.timeline} data-testid="timeline">
        {own.map((e) => (
          <RealTimelineRow key={e.event_id} event={e} contractId={contractId} onOpenPayments={onOpenPayments} />
        ))}
      </div>
      {nested.length > 0 ? (
        <div className={styles.tlNested}>
          <button
            type="button"
            className={styles.tlNestedToggle}
            aria-expanded={nestedOpen}
            onClick={() => setNestedChoice(!nestedOpen)}
            data-testid="timeline-nested-toggle"
          >
            <Icon name="chevron-down" size={16} className={nestedOpen ? styles.tlChevronOpen : styles.tlChevron} />
            <span>{t('contract.timeline.nestedGroup', { count: nested.length })}</span>
            <span className={styles.tlNestedHint}>{nestedOpen ? t('contract.timeline.hide') : t('contract.timeline.show')}</span>
          </button>
          {nestedOpen ? (
            <div className={styles.timeline} data-testid="timeline-nested">
              {nested.map((e) => (
                <RealTimelineRow key={e.event_id} event={e} contractId={contractId} onOpenPayments={onOpenPayments} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RealTimelineRow({
  event: e,
  contractId,
  onOpenPayments,
}: {
  event: import('@porukam/core').RealTimelineEvent;
  contractId: string;
  onOpenPayments: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { formatDateTime } = useFormatters();
  const kind = timelineKind(e);
  const title = timelineTitle(e);
  const nested = isNestedEvent(e);
  const link = nested ? timelineSubjectLink(contractId, e.subject, e.payload) : null;
  const subjectLabelKey = nested ? timelineSubjectLabelKey(e.subject.type) : null;
  const subjectLabel = nested
    ? e.subject.title || `${subjectLabelKey ? t(subjectLabelKey) : e.subject.type} · ${shortSubjectId(e.subject.id)}`
    : null;
  return (
    <div className={styles.tlItem} data-testid="timeline-item" data-kind={kind}>
      <span className={styles.tlTime}>{formatDateTime(e.occurred_at)}</span>
      <div className={styles.tlBody}>
        {title ? (
          <span className={styles.tlTitle}>{title}</span>
        ) : (
          <span className={styles.tlTitle}>
            {t('contract.timeline.eventFallback')} <code className={styles.tlCode}>{kind}</code>
          </span>
        )}
        {e.detail ? <span className={styles.tlDetail}>{e.detail}</span> : null}
        {subjectLabel ? (
          link && 'to' in link ? (
            <Link to={link.to} className={styles.tlSubject} data-testid="timeline-subject-link">
              {subjectLabel}
            </Link>
          ) : link && 'tab' in link ? (
            <button type="button" className={styles.tlSubject} onClick={onOpenPayments} data-testid="timeline-subject-link">
              {subjectLabel}
            </button>
          ) : (
            <span className={styles.tlSubjectPlain} data-testid="timeline-subject-label">
              {subjectLabel}
            </span>
          )
        ) : null}
      </div>
    </div>
  );
}
