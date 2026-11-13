import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  type Notification,
  type NotificationFilter,
  type NotificationType,
} from '@porukam/core';
import {
  Button,
  EmptyState,
  ErrorState,
  FilterSheet,
  Icon,
  IosInstallSheet,
  MasterDetail,
  NotificationItem,
  PushPromo,
  ScreenHeader,
  ScreenTabs,
  Sheet,
  Skeleton,
  Surface,
  useDesktopLayout,
  type IconName,
  type ScreenTabItem,
} from '@porukam/ui';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotificationsFeed,
} from '../features/notifications/api';
import { dismissPushPromo, isPushPromoDismissed } from '../features/notifications/promoDismissed';
import { usePushToggle } from '../features/notifications/usePushToggle';
import { NotificationDetailPane } from '../features/notifications/NotificationDetailPane';
import { CounterpartyLink } from '../features/counterparty/CounterpartyLink';
import { DefaultBrowserHint } from '../features/pwa/DefaultBrowserHint';
import { useFormatters } from '../shared/formatters';
import { useShellHeader } from '../features/shell/shellHeader';
import styles from './NotificationsPage.module.css';
import { apiErrorText } from '../shared/apiErrorText';

/** Иконка пункта — по типу события (§3); окраску даёт `severity` внутри `NotificationItem`. */
const TYPE_ICON: Record<NotificationType, IconName> = {
  negotiation: 'discuss',
  message: 'chat',
  signature: 'edit',
  signed: 'sealed',
  stage_submitted: 'milestone',
  deadline: 'calendar',
  accepted: 'verified',
  payment: 'wallet',
  dispute: 'dispute',
  archive_ready: 'shield',
  invite_accepted: 'share',
  group: 'share',
};

const FILTERS: NotificationFilter[] = ['all', 'unread', 'deals', 'chats', 'payments', 'deadlines', 'disputes'];

/**
 * Лента уведомлений (DEV-14): журнал событий сделок (§37a) — фильтр по query (`?filter=`),
 * группы по времени, промо-полоса push, тап по пункту = прочитано + переход по `action.href`.
 */
export function NotificationsPage(): JSX.Element {
  const { t } = useTranslation();
  const { formatDateTime, formatMoney, formatRelativeTime } = useFormatters();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawFilter = searchParams.get('filter');
  const filter: NotificationFilter = (FILTERS as string[]).includes(rawFilter ?? '') ? (rawFilter as NotificationFilter) : 'all';
  /** Выбор master-detail — в URL (DEV-19 §2): deep-link и «назад» работают, F5 не теряет его. */
  const selectedId = searchParams.get('sel');
  const isDesktop = useDesktopLayout();

  const { data, isPending, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useNotificationsFeed(filter);
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();
  /* Промо-полоса ведёт в ТОТ ЖЕ путь включения, что тумблер настроек
   * (`usePushToggle`): системный запрос → регистрация в push-сервисе →
   * сохранение настроек, а на iOS вне standalone — инструкция установки
   * вместо запроса. Своя копия этой логики здесь регистрацию не делала
   * вовсе: разрешение выдано, а уведомления не приходят (ADR-175). */
  const push = usePushToggle();
  const settings = push.settings;

  const [promoDismissed, setPromoDismissed] = useState(() => isPushPromoDismissed());
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [isOffline, setIsOffline] = useState(() => typeof navigator !== 'undefined' && !navigator.onLine);

  useEffect(() => {
    function onOnline(): void {
      setIsOffline(false);
    }
    function onOffline(): void {
      setIsOffline(true);
    }
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  function setFilter(next: NotificationFilter): void {
    const nextParams = new URLSearchParams(searchParams);
    if (next === 'all') nextParams.delete('filter');
    else nextParams.set('filter', next);
    setSearchParams(nextParams);
  }

  /** Переход к месту события — ADR-098: приоритет у явного действия,
   * фолбэк — карточка договора (отсмотр 2026-08-19: пункт обязан вести
   * к месту события). */
  function goToItem(n: Notification): void {
    const href = n.action?.href || (n.contract ? `/contracts/${n.contract.id}` : undefined);
    if (href) navigate(href);
  }

  /**
   * DEV-19 §2: `≥1024` — пункт ВЫБИРАЕТСЯ (`?sel=`) и раскрывается справа,
   * `<1024` — как раньше, сразу уводит к месту события. «Прочитано»
   * ставится в обоих случаях — это факт просмотра, не факт перехода.
   */
  function openItem(n: Notification): void {
    if (!n.read) markRead.mutate(n.id);
    if (isDesktop) {
      const next = new URLSearchParams(searchParams);
      next.set('sel', n.id);
      setSearchParams(next);
      return;
    }
    goToItem(n);
  }

  function handleDismissPromo(): void {
    dismissPushPromo();
    setPromoDismissed(true);
  }

  /* Лента идёт страницами по 15 (решение владельца 05.09): собираем
     загруженные страницы в один список, кнопка «Показать ещё» дописывает
     следующую вниз — прокрутка не прыгает. Счётчики вкладок берём с ПЕРВОЙ
     страницы: бэк считает их по всей ленте, а не по странице. Смена фильтра
     — свой ключ запроса, догруженные страницы прежнего фильтра не мешаются. */
  const pages = data?.pages ?? [];
  const feed = pages[0];
  const lastPage = pages[pages.length - 1];
  const items = pages.flatMap((page) => page.items);
  // `total` берём с ПОСЛЕДНЕЙ страницы: он пересчитан свежее всех, и «ещё N»
  // не соврёт, если лента подросла между догрузками.
  const remaining = lastPage ? Math.max(lastPage.total - items.length, 0) : 0;

  /**
   * ДВЕ главные вкладки + воронка (DEV-20_2 §3): «Все · Новые», остальные
   * категории (сделки, чаты, платежи, сроки, споры) — в шите по воронке.
   * Семь вкладок со счётчиками на 360px помещались только боковым скроллом,
   * которого в компакте нет.
   */
  const tabs: ScreenTabItem[] = [
    { key: 'all', label: t('notifications.filterAll') },
    { key: 'unread', label: t('notifications.filterUnread'), count: feed?.unread_count },
  ];
  const categoryOptions = [
    { value: 'all', label: t('notifications.filterAll') },
    { value: 'unread', label: t('notifications.filterUnread') },
    { value: 'deals', label: t('notifications.filterDeals') },
    { value: 'chats', label: t('notifications.filterChats') },
    { value: 'payments', label: t('notifications.filterPayments') },
    { value: 'deadlines', label: t('notifications.filterDeadlines') },
    { value: 'disputes', label: t('notifications.filterDisputes') },
  ];
  const funnelActive = filter !== 'all' && filter !== 'unread';

  /**
   * Кого спрашивать (ADR-175). Прежнее условие смотрело только на серверный
   * `push`, который по умолчанию `true`, — и полоса не показывалась НИКОМУ из
   * новых пользователей: разрешение на устройстве при этом не запрашивалось
   * ни разу (прод 10.09 — пять человек из семи). Теперь полоса выходит и при
   * включённом на сервере push, если разрешения нет ИМЕННО ЗДЕСЬ; отказ на
   * этом устройстве (переспросить нельзя) и «✕» её по-прежнему снимают.
   */
  const deviceNotAsked = push.device?.permission === 'default';
  const showPushPromo =
    settings != null &&
    !promoDismissed &&
    // В обёртке с нативным токеном предлагать нечего: разрешение уже у
    // приложения, а Web Push здесь не нужен (ADR-176).
    push.device?.native !== true &&
    push.device?.permission !== 'denied' &&
    settings.push_permission !== 'denied' &&
    (!settings.push || deviceNotAsked);

  const markAllButton = (
    <Button
      variant="link"
      size="sm"
      onClick={() => markAllRead.mutate()}
      disabled={!feed || feed.unread_count === 0 || markAllRead.isPending}
    >
      {t('notifications.markAllRead')}
    </Button>
  );
  // Финал доска A: на телефоне «Прочитать все» стоит в шапке оболочки
  // справа от заголовка «Уведомления»; своей шапки у экрана нет.
  const shell = useShellHeader({ actions: markAllButton });

  return (
    <div className={styles.page}>
      {shell.portal}
      {/* DEV-20 §4: компактная шапка — «Прочитать все» и настройки справа
          в той же строке, что заголовок (десктоп). */}
      <ScreenHeader
        title={t('notifications.title')}
        inShell={shell.inShell}
        actions={
          <>
            {markAllButton}
            <button
              type="button"
              className={styles.settingsBtn}
              aria-label={t('notifications.settingsAria')}
              onClick={() => navigate('/me/settings/notifications')}
            >
              <Icon name="settings" size={20} />
            </button>
          </>
        }
      />

      {isOffline ? (
        <p className={styles.offlineHint} role="status">
          {t('notifications.offlineHint')}
        </p>
      ) : null}

      <ScreenTabs
        items={tabs}
        active={filter}
        onChange={(k) => setFilter(k as NotificationFilter)}
        ariaLabel={t('notifications.title')}
        onOpenFilters={() => setFilterSheetOpen(true)}
        // «Фильтр» — общее слово интерфейса (`contracts.filtersTitle`),
        // отдельного ключа на каждый экран не заводим.
        filtersLabel={t('contracts.filtersTitle')}
        filtersActive={funnelActive}
      />

      {/* Не в Chrome — уведомления из обёртки не дойдут вовсе, поэтому подсказка
          стоит здесь же, над лентой, и один раз: «Больше не показывать» внутри
          неё скрывает её и тут, и в настройках приложения (10.09). */}
      <DefaultBrowserHint className={styles.promoWrap} />

      {showPushPromo ? (
        <div className={styles.promoWrap}>
          <PushPromo
            titleLabel={settings.push && deviceNotAsked ? t('notifications.promoTitleDevice') : t('notifications.promoTitle')}
            enableLabel={t('notifications.promoEnable')}
            dismissAriaLabel={t('notifications.promoDismissAria')}
            onEnable={push.enableOnThisDevice}
            onDismiss={handleDismissPromo}
          />
        </div>
      ) : null}

      {/* DEV-19 §2: `≥1024` — лента слева + событие справа в том же экране;
          `<1024` — та же лента во всю ширину, тап уводит к месту события. */}
      <MasterDetail
        detailLabel={t('common.details')}
        detail={() => {
          const selected = items.find((n) => n.id === selectedId);
          if (!selected) {
            return (
              <EmptyState
                icon="bell"
                title={t('notifications.paneSelectTitle')}
                text={t('notifications.paneSelectText')}
              />
            );
          }
          return (
            <NotificationDetailPane
              notification={selected}
              icon={TYPE_ICON[selected.type] ?? 'bell'}
              onOpen={() => goToItem(selected)}
            />
          );
        }}
        list={
          isPending ? (
            <div className={styles.skeletonList} aria-busy="true">
              <Skeleton width="100%" height={56} />
              <Skeleton width="100%" height={56} />
              <Skeleton width="100%" height={56} />
            </div>
          ) : error ? (
            <ErrorState
              title={t('notifications.errorTitle')}
              text={apiErrorText(error)}
              code={error instanceof ApiError ? error.code : undefined}
              retryLabel={t('common.retry')}
              onRetry={() => void refetch()}
            />
          ) : items.length === 0 ? (
            <EmptyState
              icon="bell"
              title={filter === 'all' ? t('notifications.emptyTitle') : t('notifications.emptyFilteredTitle')}
              text={filter === 'all' ? t('notifications.emptyText') : t('notifications.emptyFilteredText')}
            />
          ) : (
            /* Финал доска A: одна лента строк во всю ширину без заголовков
               «Сегодня/Вчера/Ранее» — время и так стоит в каждой строке. */
            <>
            <Surface bleed data-testid="notifications-list">
                      {items.map((n) => (
                        <NotificationItem
                          key={n.id}
                          icon={TYPE_ICON[n.type] ?? 'bell'}
                          severity={n.severity}
                          title={n.title}
                          // DEV-20 §2: лид пункта — аватар контрагента; у
                          // системного события человека нет, там останется
                          // иконка типа.
                          avatarName={n.counterparty?.name ?? undefined}
                          /* ADR-173: фото контрагента вместо инициалов. */
                          avatarSrc={n.counterparty?.avatar_url ?? undefined}
                          // Бэклог 2026-08-21: контрагент в ленте — ссылка на его карточку.
                          metaSlot={
                            n.counterparty ? (
                              <CounterpartyLink
                                profileId={n.counterparty.profile_id}
                                name={n.counterparty.name}
                                showHandle={false}
                                plain
                              />
                            ) : undefined
                          }
                          /* DEV-20_2 §2 + финал доска A: в строке — НАЗВАНИЕ
                             договора («Аренда квартиры · 4 дня»), номер живёт
                             в карточке. Это разворот отсмотра 2026-08-19,
                             который выбрал ровно наоборот — тогда доски ещё
                             не было. Номер остаётся ФОЛБЭКОМ: у реального
                             фида названия в payload может не быть (ADR-098),
                             и молча оставлять пункт без ссылки на договор
                             хуже, чем показать номер. */
                          metaLabel={
                            n.contract?.title ||
                            (n.contract?.number
                              ? t('notifications.contractNo', { number: n.contract.number })
                              : undefined)
                          }
                          amountLabel={n.amount ? formatMoney(n.amount) : undefined}
                          timeLabel={formatRelativeTime(n.created_at, Date.now())}
                          exactTimeLabel={formatDateTime(n.created_at)}
                          unread={!n.read}
                          unreadAriaLabel={t('notifications.unreadAria')}
                          selected={n.id === selectedId}
                          onOpen={() => openItem(n)}
                        />
                      ))}
            </Surface>
            {/* «Показать ещё N» — решение владельца 05.09: лента больше не
                тянется в бесконечность, следующие 15 догружаются по кнопке.
                На 360px кнопка во всю ширину (block) и в тач-таргет 44px. */}
            {hasNextPage ? (
              <div className={styles.showMore}>
                <Button
                  variant="secondary"
                  block
                  loading={isFetchingNextPage}
                  data-testid="notifications-show-more"
                  onClick={() => void fetchNextPage()}
                >
                  {t('notifications.showMore', { count: remaining })}
                </Button>
              </div>
            ) : null}
            </>
          )
        }
      />

      <Sheet
        open={push.sheetOpen}
        title={t('notifications.pushSheetTitle')}
        onClose={() => push.setSheetOpen(false)}
        closeLabel={t('common.close')}
        actions={
          <>
            <Button variant="ghost" onClick={() => push.setSheetOpen(false)}>
              {t('notifications.pushSheetNotNow')}
            </Button>
            <Button variant="primary" onClick={() => void push.confirm()}>
              {t('notifications.pushSheetAllow')}
            </Button>
          </>
        }
      >
        <p>{t('notifications.push_permission_prompt')}</p>
      </Sheet>

      {/* iOS вне standalone (DEV-15 §5): системного запроса там нет вовсе —
          из промо-полосы ведём в инструкцию установки, а не в тупик. */}
      <IosInstallSheet
        open={push.iosGateOpen}
        onClose={() => push.setIosGateOpen(false)}
        titleLabel={t('pwa.iosSheetTitle')}
        step1Label={t('pwa.iosSheetStep1')}
        step2Label={t('pwa.iosSheetStep2')}
        step3Label={t('pwa.iosSheetStep3')}
        pushHintLabel={t('pwa.iosSheetPushHint')}
        closeLabel={t('pwa.iosSheetClose')}
      />

      {/* Категории ленты (сделки/чаты/платежи/сроки/споры) — в шите по
          воронке (DEV-20_2 §3), в строке вкладок остались две главные. */}
      <FilterSheet
        open={filterSheetOpen}
        onClose={() => setFilterSheetOpen(false)}
        closeLabel={t('common.close')}
        title={t('contracts.filtersTitle')}
        categoryLabel={t('contracts.filterCategory')}
        categoryValue={filter}
        categoryOptions={categoryOptions}
        onCategoryChange={(v) => setFilter(v as NotificationFilter)}
        resetLabel={t('contracts.filtersReset')}
        onReset={() => setFilter('all')}
        applyLabel={t('common.apply')}
      />
    </div>
  );
}
