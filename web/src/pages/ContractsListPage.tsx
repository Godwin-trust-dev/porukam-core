import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError, type ContractRole } from '@porukam/core';
import {
  Button,
  EmptyState,
  ErrorState,
  Fab,
  FilterSheet,
  Icon,
  MasterDetail,
  ScreenHeader,
  ScreenTabs,
  SearchInput,
  Skeleton,
  Surface,
  useDesktopLayout,
  type ScreenTabItem,
} from '@porukam/ui';
import { activeProfile } from '../features/actor/actorStore';
import { useRealContractsList } from '../features/contracts/realApi';
import { RealContractRow as ContractRow } from '../features/contracts/RealContractRow';
import { ContractDetailPane } from '../features/contracts/ContractDetailPane';
import { MUTED_STATUSES, bucketOf, compareByStatus, realCardStatus } from '../features/contracts/realStatus';
import { useOpenWarrantyClaims } from '../features/contracts/useOpenWarrantyClaims';
import { useDebounced } from '../shared/useDebounced';
import { useShellHeader } from '../features/shell/shellHeader';
import styles from './ContractsListPage.module.css';

type Tab = 'active' | 'archive' | 'drafts' | 'all';
type Sort = 'created' | 'amount' | 'status';

/**
 * Список сделок / «Мои договоры» (DEV-13): `/contracts`. Фаза 1 (ADR-088,
 * docs/tasks/Промт_contracts-phase1-read-create.md) — реальный
 * `GET /v1/contracts` (только `role`/`negotiation_status`/`segment` на бэке,
 * `apps.contracts.api.views.ContractListCreateView.get`): вкладки/поиск/
 * сортировка — клиентские, сфера/статус/способ-оплаты как ОТДЕЛЬНЫЕ фильтры
 * убраны (каталога сфер нет — `feat/catalog-real-api`, статуса-каталога на
 * бэке тоже нет; способ оплаты — виден в строке, но не как фильтр — Фаза 1).
 */
export function ContractsListPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const tab = (searchParams.get('tab') as Tab) || 'active';
  const role = (searchParams.get('role') as ContractRole | null) ?? undefined;
  const qParam = searchParams.get('q') ?? '';
  const sort = (searchParams.get('sort') as Sort) || 'created';
  /** Выбор master-detail живёт в URL (DEV-19 §2): deep-link, «назад» и F5 не теряют его. */
  const selected = searchParams.get('sel');
  const isDesktop = useDesktopLayout();

  const [qInput, setQInput] = useState(qParam);
  const qDebounced = useDebounced(qInput, 350);
  useEffect(() => setQInput(qParam), [qParam]);
  useEffect(() => {
    if (qDebounced === qParam) return;
    updateParams({ q: qDebounced || undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDebounced]);

  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  // Финал доска A: на телефоне заголовок «Сделки» несёт шапка оболочки,
  // своей шапки у экрана нет (второе «Мои договоры» под ней — лишнее).
  const shell = useShellHeader({});

  function updateParams(patch: Record<string, string | undefined>): void {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setSearchParams(next);
  }

  const { data, isPending, error, refetch } = useRealContractsList({ role });
  // Гарантийный случай возвращает сделку в «Активные» (решение владельца
  // 31.08) — тот же признак, что на дашборде.
  const openWarrantyClaims = useOpenWarrantyClaims();

  const buckets = useMemo(() => {
    const all = data ?? [];
    return {
      active: all.filter((c) => bucketOf(c, openWarrantyClaims) === 'active'),
      archive: all.filter((c) => bucketOf(c, openWarrantyClaims) === 'archive'),
      drafts: all.filter((c) => bucketOf(c, openWarrantyClaims) === 'drafts'),
      all,
    };
  }, [data, openWarrantyClaims]);

  /**
   * ТРИ вкладки — решение владельца 03.09 («черновики сложно найти, нужно в
   * фильтр заходить»), перекрывает DEV-20_2 §3 и доску A для этого экрана:
   * «Активные · Черновики · Архив» короткие и на 360px помещаются без
   * бокового скролла (`allowExtra`). «Все», роль и сортировка — по-прежнему
   * в воронке; «Черновики» из шита убраны, чтобы не дублировать вкладку.
   */
  const tabItems: ScreenTabItem[] = [
    { key: 'active', label: t('contracts.tabActive'), count: buckets.active.length },
    { key: 'drafts', label: t('contracts.tabDrafts'), count: buckets.drafts.length },
    { key: 'archive', label: t('contracts.tab_archive'), count: buckets.archive.length },
  ];
  // Категория в воронке — только то, чего нет вкладками: «Все» (плюс текущая
  // вкладка, чтобы селект показывал действующее значение и позволял
  // вернуться из «Все» на любую из трёх).
  const tabOnFunnel = tabItems.some((it) => it.key === tab);
  const categoryOptions = [
    ...tabItems.filter((it) => !tabOnFunnel || it.key === tab).map((it) => ({ value: it.key, label: it.label })),
    { value: 'all', label: t('contracts.tabAll') },
  ];

  const roleOptions = [
    // DEV-17 §1: без дубль-лейбла — заголовок поля «Роль» отдельно, «все» — значением.
    { value: '', label: t('contracts.filterRoleAny') },
    { value: 'customer', label: t('contracts.filterRoleCustomer') },
    { value: 'contractor', label: t('contracts.filterRoleContractor') },
  ];
  const sortOptions = [
    { value: 'created', label: t('contracts.sortUpdated') },
    { value: 'amount', label: t('contracts.sortAmount') },
    // Замечание владельца 31.08: в архиве всё лежало кучей — завершённые
    // вперемешку с отклонёнными и расторгнутыми.
    { value: 'status', label: t('contracts.sortStatus') },
  ];

  const hasActiveFilters = !!(role || qParam);
  /** Воронка помечается точкой и когда выбрана категория не из вкладок («Все»). */
  const funnelActive = hasActiveFilters || !tabOnFunnel;

  function resetFilters(): void {
    updateParams({ role: undefined, q: undefined });
    setQInput('');
  }

  /**
   * Одна и та же строка ведёт себя по ширине (DEV-19 §2): `≥1024` — выбирает
   * запись и открывает её справа (`?sel=`, БЕЗ ухода со списка), `<1024` —
   * обычная навигация на страницу карточки. Дублей `*Desktop`-маршрутов нет.
   */
  function openContract(contractId: string): void {
    if (isDesktop) updateParams({ sel: contractId });
    else navigate(`/contracts/${contractId}`);
  }

  const tabItemsData = buckets[tab];
  const filtered = useMemo(() => {
    const q = qParam.trim().toLowerCase();
    let items = tabItemsData;
    if (q) {
      items = items.filter((c) => c.title.toLowerCase().includes(q) || c.id.toLowerCase().includes(q));
    }
    const sorted = [...items];
    if (sort === 'amount') {
      sorted.sort((a, b) => Number(b.total?.amount ?? 0) - Number(a.total?.amount ?? 0));
    } else if (sort === 'status') {
      sorted.sort(compareByStatus);
    } else {
      sorted.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    }
    return sorted;
  }, [tabItemsData, qParam, sort]);

  const searchField = (
    <SearchInput value={qInput} onChange={setQInput} placeholder={t('contracts.searchPlaceholder')} clearLabel={t('contracts.searchClear')} />
  );

  return (
    <div className={styles.wrap}>
      {shell.portal}
      {/* DEV-20 §4: компактный заголовок экрана. Кнопка «+ Создать» здесь —
          десктопная (эталон compact-десктопа); на телефоне то же действие
          даёт FAB внизу справа (DEV-20_2 §5), а заголовок несёт шапка
          оболочки (`inShell`). */}
      <ScreenHeader
        title={t('contracts.title')}
        inShell={shell.inShell}
        actions={
          <span className={styles.createDesktop}>
            <Button variant="primary" size="sm" onClick={() => navigate('/contracts/new')} data-testid="create-contract">
              <Icon name="plus" size={16} />
              {t('contracts.createCta')}
            </Button>
          </span>
        }
      />

      <ScreenTabs
        items={tabItems}
        active={tab}
        allowExtra
        onChange={(key) => updateParams({ tab: key === 'active' ? undefined : key })}
        ariaLabel={t('contracts.title')}
        onOpenFilters={() => setFilterSheetOpen(true)}
        filtersLabel={t('contracts.filtersTitle')}
        filtersActive={funnelActive}
      />

      {/* DEV-19 §2: `≥1024` — список слева + карточка справа в том же экране;
          `<1024` — тот же список во всю ширину, колонки деталей просто нет. */}
      <MasterDetail
        detailLabel={t('common.details')}
        detail={() =>
          selected ? (
            <ContractDetailPane contractId={selected} />
          ) : (
            <EmptyState icon="deals" title={t('contracts.paneSelectTitle')} text={t('contracts.paneSelectText')} />
          )
        }
        list={
          <div className={styles.listColumn}>
            {/* Один вход в фильтры на экран (DEV-20_2 §3): воронка в строке
                вкладок. Поиск — в тулбаре колонки на десктопе (эталон
                compact-десктопа); на телефоне над списком его нет (финал
                доска A) — то же поле стоит первым в шите по воронке. */}
            <div className={styles.toolbar}>
              <div className={styles.searchRow}>{searchField}</div>
            </div>

            {isPending ? (
              <div className={styles.loadingList} aria-busy="true">
                <Skeleton height={56} radius="var(--pr-d-r-surface)" />
                <Skeleton height={56} radius="var(--pr-d-r-surface)" />
                <Skeleton height={56} radius="var(--pr-d-r-surface)" />
              </div>
            ) : error || !data ? (
              <ErrorState title={t('contracts.errorText')} code={error instanceof ApiError ? error.code : undefined} retryLabel={t('common.retry')} onRetry={() => void refetch()} />
            ) : filtered.length === 0 ? (
              hasActiveFilters ? (
                <EmptyState icon="search" title={t('contracts.emptySearchTitle')} text={t('contracts.emptySearchText')} actionLabel={t('contracts.emptySearchReset')} onAction={resetFilters} />
              ) : tab === 'active' ? (
                <EmptyState
                  icon="deals"
                  title={t('contracts.emptyActiveTitle')}
                  text={t('contracts.emptyActiveText')}
                  actionLabel={t(activeProfile()?.kind === 'business' ? 'contracts.emptyActiveActionContractor' : 'contracts.emptyActiveActionCustomer')}
                  onAction={() => navigate('/contracts/new')}
                />
              ) : tab === 'archive' ? (
                <EmptyState icon="deals" title={t('contracts.emptyArchiveTitle')} text={t('contracts.emptyArchiveText')} />
              ) : tab === 'drafts' ? (
                <EmptyState icon="deals" title={t('contracts.emptyDraftsTitle')} text={t('contracts.emptyDraftsText')} actionLabel={t('contracts.createCta')} onAction={() => navigate('/contracts/new')} />
              ) : (
                <EmptyState icon="deals" title={t('contracts.emptyAllTitle')} text={t('contracts.emptyAllText')} />
              )
            ) : (
              <Surface bleed className={styles.list} data-testid="contracts-list">
                {tab === 'archive'
                  ? (() => {
                      const concluded = filtered.filter((c) => !MUTED_STATUSES.includes(realCardStatus(c)));
                      const notConcluded = filtered.filter((c) => MUTED_STATUSES.includes(realCardStatus(c)));
                      return (
                        <>
                          {concluded.map((c) => (
                            <ContractRow key={c.id} contract={c} selected={c.id === selected} onOpen={() => openContract(c.id)} onOpenId={(id) => navigate(`/contracts/${id}`)} onDeleted={(id) => { if (id === selected) updateParams({ sel: undefined }); }} />
                          ))}
                          {notConcluded.length > 0 ? (
                            <>
                              <p className={styles.groupDivider}>{t('contracts.archiveGroupNotConcluded')}</p>
                              {notConcluded.map((c) => (
                                <ContractRow key={c.id} contract={c} selected={c.id === selected} onOpen={() => openContract(c.id)} onOpenId={(id) => navigate(`/contracts/${id}`)} onDeleted={(id) => { if (id === selected) updateParams({ sel: undefined }); }} />
                              ))}
                            </>
                          ) : null}
                        </>
                      );
                    })()
                  : filtered.map((c) => (
                      <ContractRow key={c.id} contract={c} selected={c.id === selected} onOpen={() => openContract(c.id)} onOpenId={(id) => navigate(`/contracts/${id}`)} onDeleted={(id) => { if (id === selected) updateParams({ sel: undefined }); }} />
                    ))}
              </Surface>
            )}
          </div>
        }
      />

      <FilterSheet
        open={filterSheetOpen}
        onClose={() => setFilterSheetOpen(false)}
        closeLabel={t('common.close')}
        title={t('contracts.filtersTitle')}
        categoryLabel={t('contracts.filterCategory')}
        categoryValue={tab}
        categoryOptions={categoryOptions}
        onCategoryChange={(v) => updateParams({ tab: v === 'active' ? undefined : v })}
        roleLabel={t('contracts.filterRoleAll')}
        roleValue={role ?? ''}
        roleOptions={roleOptions}
        onRoleChange={(v) => updateParams({ role: v || undefined })}
        sortLabel={t('contracts.sortLabel')}
        sortValue={sort}
        sortOptions={sortOptions}
        onSortChange={(v) => updateParams({ sort: v || undefined })}
        resetLabel={t('contracts.filtersReset')}
        onReset={resetFilters}
        applyLabel={t('common.apply')}
      >
        {/* Шит закрытым не рендерится (`Sheet` → null), поэтому второго поля
            в DOM нет, пока воронка не открыта. */}
        {isDesktop ? null : searchField}
      </FilterSheet>

      {/* «Создать» на списке — FAB, а не тёмная кнопка в ленте (DEV-20_2 §5). */}
      <Fab label={t('contracts.createCta')} onClick={() => navigate('/contracts/new')} data-testid="create-contract-fab" />
    </div>
  );
}
