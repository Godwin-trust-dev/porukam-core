import { useState } from 'react';
import { usePortfolioProjects } from '../features/portfolio/api';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  type CountRatio,
  type PortfolioProjectDto,
  type ReputationCard,
  type ReputationDealFact,
  type ReputationSphereStats,
} from '@porukam/core';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Icon,
  LanguageSwitcher,
  LtrText,
  Modal,
  PassportHeader,
  PreviewBar,
  SectionLabel,
  Skeleton,
  SphereRow,
  StatusWord,
  Surface,
  ZoneBar,
} from '@porukam/ui';
import { useAuthStore } from '../features/auth/authStore';
import { useCurrentUser } from '../features/auth/useAuth';
import { useHandlePublic, useReputationCard } from '../features/reputation/api';
import { useSpheres } from '../features/contractNew/api';
import { useLanguageSwitcherProps } from '../features/locale/useLanguageSwitcherProps';
import { useFormatters } from '../shared/formatters';
import { contractTypeLabelKey } from '../features/contracts/RealContractRow';
import styles from './ReputationCardPage.module.css';
import { copyToClipboard } from '../shared/clipboard';
import { useSaveContact, useSavedContacts } from '../features/contacts/api';
import { isFeatureEnabled } from '../shared/features';
import { ProjectViewModal } from '../features/portfolio/ProjectView';
import { SphereChips } from '../features/profile/SphereChips';
import { apiErrorText } from '../shared/apiErrorText';
import { useGroup, useGroupMembers } from '../features/groups/api';
import { GroupCard } from '../features/groups/GroupCard';
import { groupKindLabelKey } from '../features/groups/groupLabels';

/**
 * Репутационная карточка на реальном контракте (ADR-076/093).
 *
 * Два маршрута, один компонент: `/@handle` (публичная ссылка — хендл
 * разрешается в `profile_id` через `GET /v1/handles/{handle}`) и
 * `/reputation/profiles/:profileId` (прямая ссылка со стороны договора —
 * карточка сама несёт `handle`).
 *
 * Показывается РОВНО то, что отдаёт бэк. По макету владельца 05.09
 * (ADR-163) это: плитки фактов, разделы «по сферам и ролям» и
 * «надёжность», объединения и список завершённых сделок.
 *
 * Двух вещей здесь нет НИКОГДА, хотя бэк их считает: объёма по валютам и
 * доли защищённых платежей (ADR-163 §4 — коммерческая тайна стороны, а не
 * факт её надёжности). Их видит только сам владелец на `/me/reputation`.
 * Сводного балла и звёзд нет вовсе: карточка показывает дроби, а не
 * оценки (domain-model.md §13).
 *
 * Слова «в срок» без уточнения на экране не существует: у исполнителя это
 * «сделано в срок», у заказчика — «оплачено в срок» и «принято без
 * затягивания» (ADR-163 §1).
 */
export function ReputationCardPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // React Router не матчит статичный префикс + параметр в одном сегменте, поэтому
  // маршрут «/:handle» отдаёт весь сегмент целиком — «@» проверяем здесь сами.
  const { handle: rawHandle, profileId: routeProfileId } = useParams<{ handle?: string; profileId?: string }>();
  const byHandle = routeProfileId === undefined;
  const looksLikeHandle = !!rawHandle && rawHandle.startsWith('@') && rawHandle.length > 1;

  const handleQuery = useHandlePublic(byHandle && looksLikeHandle ? rawHandle : undefined);
  const profileId = routeProfileId ?? handleQuery.data?.profile_id ?? undefined;
  const cardQuery = useReputationCard(profileId);
  // Вход по profile_id: статус верификации живёт в apps.social и достаётся
  // только по хендлу, который приезжает с самой карточкой.
  const cardHandleQuery = useHandlePublic(byHandle ? undefined : cardQuery.data?.handle);
  const handleData = byHandle ? handleQuery.data : cardHandleQuery.data;

  if (byHandle && !looksLikeHandle) return <NotFound />;

  const loading = byHandle
    ? handleQuery.isLoading || (!!profileId && cardQuery.isLoading)
    : cardQuery.isLoading;
  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>
          <Skeleton width={88} height={88} radius="50%" />
          <Skeleton width="40%" height={28} />
          <Skeleton width="60%" height={16} />
          <Skeleton width="100%" height={120} />
        </div>
      </div>
    );
  }

  const error = handleQuery.error ?? cardQuery.error;
  if (error) {
    if (error instanceof ApiError && (error.is('not_found') || error.status === 404)) return <NotFound />;
    return (
      <div className={styles.page}>
        <div className={styles.centered}>
          <ErrorState
            title={t('reputation.errorTitle')}
            text={apiErrorText(error)}
            code={error instanceof ApiError ? error.code : undefined}
            retryLabel={t('common.retry')}
            onRetry={() => void (byHandle && !profileId ? handleQuery.refetch() : cardQuery.refetch())}
          />
        </div>
      </div>
    );
  }

  // Хендл объединения (`kind: 'group'`) — публичная карточка объединения
  // (ADR-117 §6: бэк отдаёт group_id). Старый бэк/легаси без group_id —
  // честная заглушка «карточки нет».
  if (byHandle && handleQuery.data && !handleQuery.data.profile_id) {
    if (handleQuery.data.group_id) {
      return <GroupPublicPage groupId={handleQuery.data.group_id} onNavigate={navigate} />;
    }
    return (
      <div className={styles.page}>
        <div className={styles.centered}>
          <EmptyState icon="reputation" title={t('reputation.noCardTitle')} text={t('reputation.noCardText')} />
        </div>
      </div>
    );
  }

  if (!cardQuery.data) return <NotFound />;

  return (
    <CardView
      card={cardQuery.data}
      verified={handleData?.verified}
      fallbackHandle={byHandle && looksLikeHandle ? rawHandle.slice(1) : undefined}
      // Полоса «как гость» нужна только на ПУБЛИЧНОМ «/@хендл» — он идёт вне
      // оболочки, вернуться оттуда нечем (замечание владельца 05.09). Маршрут
      // «/reputation/profiles/:id» живёт внутри оболочки: там уже есть меню и
      // липкая шапка, вторая полоса поверх неё была бы шумом.
      outsideShell={byHandle}
      onNavigate={navigate}
    />
  );
}

/** Гостевая карточка объединения по `/@хендл` (ADR-118): та же `GroupCard`,
 * что в `/groups/{id}`, без оболочки и без действий участника — гость
 * регистрируется, участник заходит через оболочку. Участники кликабельны в
 * их публичные `/@хендл` (маршрут по profile_id живёт в оболочке). */
function GroupPublicPage({ groupId, onNavigate }: { groupId: string; onNavigate: (to: string) => void }): JSX.Element {
  const { t } = useTranslation();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const languageSwitcherProps = useLanguageSwitcherProps();
  const groupQ = useGroup(groupId);
  const membersQ = useGroupMembers(groupId);
  if (groupQ.isPending) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>
          <Skeleton width={88} height={88} radius="12px" />
          <Skeleton width="40%" height={28} />
          <Skeleton width="100%" height={120} />
        </div>
      </div>
    );
  }
  if (groupQ.error || !groupQ.data) return <NotFound />;
  return (
    <div className={styles.page}>
      <div className={styles.layout}>
        <GroupCard
          group={groupQ.data}
          members={membersQ.data}
          membersPending={membersQ.isPending}
          onOpenMember={(m) => onNavigate(m.member_handle ? `/${m.member_handle}` : `/reputation/profiles/${m.member_profile_id}`)}
          actions={
            isAuthenticated ? (
              <Button variant="primary" onClick={() => onNavigate(`/groups/${groupId}`)}>
                {t('dashboard.groupMemberOpenProfile')}
              </Button>
            ) : (
              <>
                <LanguageSwitcher variant="globe" {...languageSwitcherProps} />
                <Button variant="primary" onClick={() => onNavigate('/welcome')}>
                  {t('reputation.orRegisterOnSite')}
                </Button>
              </>
            )
          }
        />
      </div>
    </div>
  );
}

function NotFound(): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className={styles.page}>
      <div className={styles.centered}>
        <EmptyState icon="reputation" title={t('reputation.notFoundTitle')} text={t('reputation.notFoundText')} />
      </div>
    </div>
  );
}

function CardView({
  card,
  verified,
  fallbackHandle,
  outsideShell,
  onNavigate,
}: {
  card: ReputationCard;
  verified: boolean | undefined;
  fallbackHandle: string | undefined;
  outsideShell: boolean;
  onNavigate: (to: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const { data: me } = useCurrentUser();
  const languageSwitcherProps = useLanguageSwitcherProps();
  const [shareOpen, setShareOpen] = useState(false);
  // Отсмотр 2026-08-23: «фото при нажатии не увеличивается» — кнопка-лупа
  // PassportHeader была без обработчика.
  const [avatarOpen, setAvatarOpen] = useState(false);
  // ADR-120: «поле работы не кликабельное, не получается провалиться и
  // посмотреть описание» — просмотр работы с галереей и описанием.
  const [viewingWork, setViewingWork] = useState<PortfolioProjectDto | null>(null);
  const contactsQ = useSavedContacts(isAuthenticated);
  const saveContact = useSaveContact();
  const isSaved =
    saveContact.isSuccess ||
    !!contactsQ.data?.some((c) => c.target_profile_id === card.profile_id || (card.handle && c.target_handle === `@${card.handle}`));
  // ADR-115: портфолио — публичная витрина; на карточке показываем только
  // опубликованные работы.
  const portfolioQ = usePortfolioProjects(card.profile_id);
  const works = (portfolioQ.data ?? []).filter((p) => p.is_published);

  const handle = card.handle ?? fallbackHandle;
  const atHandle = handle ? `@${handle}` : undefined;
  async function copyHandle(): Promise<void> {
    if (atHandle) await copyToClipboard(atHandle);
  }
  const isOwner = isAuthenticated && !!me && me.profiles.some((p) => p.id === card.profile_id);
  const shareUrl = atHandle
    ? `${window.location.origin}/${atHandle}`
    : `${window.location.origin}/reputation/profiles/${card.profile_id}`;

  // Дубля выхода в действиях шапки НЕТ намеренно: полоса предпросмотра липкая
  // и остаётся на экране при любом скролле (e2e «полоса остаётся видимой»), так
  // что вторая кнопка «В профиль» в 40px под первой была бы только шумом — и на
  // 360px лишней белой плашкой, отодвигающей саму карточку вниз.
  const actions = isOwner ? (
    <Button variant="ghost" leftIcon={<Icon name="share" size={16} />} onClick={() => setShareOpen(true)}>
      {t('reputation.share')}
    </Button>
  ) : isAuthenticated ? (
    <>
      {/* Отсмотр 22.08: «при просмотре контакта нужно добавить возможность сохранить контакт» */}
      {atHandle ? (
        <Button
          variant={isSaved ? 'ghost' : 'primary'}
          disabled={isSaved || saveContact.isPending}
          leftIcon={<Icon name={isSaved ? 'verified' : 'plus'} size={16} />}
          onClick={() => saveContact.mutate({ target_handle: atHandle })}
          data-testid="save-contact"
        >
          {isSaved ? t('reputation.contactSaved') : t('reputation.saveContact')}
        </Button>
      ) : null}
      {/* Чат выключен (отсмотр 22.08) — кнопка «Написать» за фич-флагом */}
      {isFeatureEnabled('chat') ? (
        <Button variant="primary" onClick={() => onNavigate('/chat')}>
          {t('reputation.write')}
        </Button>
      ) : null}
      {/* TODO: предзаполнение контрагента в мастере договора — вне скоупа DEV-01 (§12) */}
      <Button variant="ghost" onClick={() => onNavigate('/contracts/new')}>
        {t('reputation.proposeDeal')}
      </Button>
    </>
  ) : (
    <>
      {/* DEV-16a §3/§6 — глобус слева от «зарегистрироваться»: гость меняет язык до
          логина. surface="on-ink" — триггер стоит на чернильном герое (qa-backlog
          2026-08-20 §3: тёмный чип на тёмном фоне не читался). */}
      <LanguageSwitcher variant="globe" surface="on-ink" {...languageSwitcherProps} />
      {/* GLOBAL-волна — вход только Google (Задача_feat_web-global-entry.md §1), не /login (телефон). */}
      <Button variant="primary" onClick={() => onNavigate('/welcome')}>
        {t('reputation.orRegisterOnSite')}
      </Button>
    </>
  );

  return (
    <div className={styles.page}>
      {/* Замечание владельца 05.09: «при просмотре своей карточки „как гость“
          не понятно как вернуться обратно — зависает в неопределённости».
          Полоса — только владельцу: гость и чужой авторизованный её не видят. */}
      {isOwner && outsideShell ? (
        <PreviewBar
          className={styles.previewBar}
          text={t('reputation.ownerPreviewBanner')}
          backLabel={t('reputation.ownerPreviewBack')}
          onBack={() => onNavigate('/me')}
        />
      ) : null}
      <div className={styles.layout}>
        <div className={styles.rail}>
          <div className={styles.header}>
            <PassportHeader
              surface="on-ink"
              // show_name=False → бэк отдаёт display_name: null; подставляем честную
              // подпись, а не хендл вторым экземпляром (он и так строкой ниже).
              name={card.display_name ?? t('reputation.nameHidden')}
              handle={atHandle}
              onCopyHandle={() => void copyHandle()}
              copyHandleLabel={t('common.copyHandle')}
              copiedLabel={t('common.copied')}
              // Статус верификации известен только через хендл (apps.social);
              // нет хендла — плашки нет вовсе, а не «Не подтверждён».
              // Отсмотр 2026-08-21: «Не подтверждён» не показываем — только
              // положительная верификация; без неё плашки нет вовсе.
              verification={verified ? 'id' : undefined}
              verificationLabel={verified ? t('reputation.verificationId') : undefined}
              avatarUrl={card.avatar_url ?? undefined}
              expandLabel={t('reputation.expandAvatar')}
              onAvatarClick={() => setAvatarOpen(true)}
              actions={actions}
            />
          </div>
        </div>

        <div className={styles.body}>
          {/* Компакт-плотность профиля по доске A (замечание владельца 03.09
              «смотреть как гость — тоже большие рамки, отступы»): цифры —
              плитки в ритме хаба `/me`, а не карточка с рамкой и крупным
              внутренним воздухом. */}
          <div className={styles.numberArea}>
            {/* Плитки фактов — ОДНА поверхность сеткой 2×2 с hairline-
                разделителями на узком экране (замечание владельца 05.09:
                «без боковых рамок»); рамка у каждой плитки возвращается
                только на десктопе, где поверхность и так не во всю ширину. */}
            <Surface bleed className={styles.factsSurface} data-testid="card-stats">
              <div className={styles.facts}>
                <Stat
                  value={card.restricted ? null : card.deals_count}
                  label={t('reputation.dealsCountLabel')}
                  hidden={card.restricted}
                  hiddenLabel={t('reputation.hiddenValue')}
                />
                <Stat
                  value={card.restricted ? null : card.counterparties_count}
                  label={t('reputation.counterpartiesCountLabel')}
                  hidden={card.restricted}
                  hiddenLabel={t('reputation.hiddenValue')}
                />
                <RatioTile
                  ratio={card.disputes_free}
                  label={t('reputation.disputesFreeLabel')}
                  statLabel={(r) => t('reputation.statDisputesFree', { done: r.done, total: r.total })}
                  hidden={card.restricted}
                  hiddenLabel={t('reputation.hiddenValue')}
                  emptyLabel={t('reputation.noAxisData')}
                />
                {/* Ось ИСПОЛНИТЕЛЯ — с явной подписью роли: одна и та же
                    плитка у заказчика означала бы чужой срок (ADR-163 §1). */}
                <RatioTile
                  ratio={card.by_role?.contractor.on_time_delivery ?? null}
                  label={t('reputation.onTimeDeliveryLabel')}
                  statLabel={(r) =>
                    t('reputation.statOnTimeDelivery', { done: r.done, total: r.total })
                  }
                  hidden={card.restricted}
                  hiddenLabel={t('reputation.hiddenValue')}
                  emptyLabel={t('reputation.noAxisData')}
                />
              </div>
            </Surface>
            {/* Возраст профиля виден всегда, включая стартовую карточку (ADR-076 §2). */}
            <p className={styles.since}>
              {t('reputation.onPlatformSince', { date: formatDate(card.created_at) })} ·{' '}
              {t('reputation.profileAgeDays', { days: card.profile_age_days })}
            </p>
          </div>

          {(card.sphere_codes?.length ?? 0) > 0 ? (
            <div className={styles.numberArea}>
              <SphereChips codes={card.sphere_codes ?? []} testId="card-spheres" />
            </div>
          ) : null}

          {/* Десктоп ≥1024 — две колонки: сферы слева (1.6fr), надёжность и
              объединения справа. На узком экране обе колонки просто идут
              одна за другой (grid без media-запроса — один поток). */}
          <div className={styles.columns}>
            <div className={styles.colMain}>
              <SpheresSection card={card} />
            </div>
            <div className={styles.colSide}>
              <ReliabilitySection card={card} />
              {card.groups.length > 0 ? (
                <div className={styles.numberArea}>
                  <SectionLabel level={3}>{t('reputation.groupsTitle')}</SectionLabel>
                  <Surface bleed data-testid="card-groups">
                    {card.groups.map((g) => (
                      <button
                        key={g.id}
                        type="button"
                        className={styles.groupRow}
                        onClick={() => onNavigate(g.handle ? `/@${g.handle}` : `/groups/${g.id}`)}
                      >
                        <span className={styles.groupName}>{g.name}</span>
                        <span className={styles.groupKind}>{t(groupKindLabelKey(g.kind))}</span>
                      </button>
                    ))}
                  </Surface>
                </div>
              ) : null}
            </div>
          </div>

          <div className={styles.dealsArea}>
            {card.restricted ? (
              <Surface padded bleed className={styles.lockedCard}>
                <Icon name="reputation" size={32} />
                <h2 className={styles.sectionTitle}>{t('reputation.restrictedTitle')}</h2>
                {/* CTA «зарегистрироваться» здесь НЕ дублируется — он уже в шапке
                    (actions гостя), qa-backlog 2026-08-20 §3. */}
                <p className={styles.lockedText}>{t('reputation.restrictedText')}</p>
              </Surface>
            ) : (
              <>
              {works.length > 0 ? (
                <section>
                  <SectionLabel level={3}>{t('profile.portfolioWorksTitle')}</SectionLabel>
                  <div className={styles.worksGrid} data-testid="card-portfolio">
                    {works.map((w) => (
                      <button
                        key={w.id}
                        type="button"
                        className={`${styles.workItem} ${styles.workButton}`}
                        onClick={() => setViewingWork(w)}
                        aria-label={`${t('profile.portfolioOpenWork')}: ${w.title}`}
                        data-testid={`card-work-${w.id}`}
                      >
                        {w.photo_url ? (
                          <img src={`${w.photo_url}&size=320`} alt="" className={styles.workPhoto} />
                        ) : null}
                        <span>{w.title}</span>
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}
              <section>
                <SectionLabel level={3}>{t('reputation.dealsTitle')}</SectionLabel>
                {card.deals.length === 0 ? (
                  <EmptyState icon="reputation" title={t('reputation.dealsEmptyTitle')} text={t('reputation.dealsEmptyText')} />
                ) : (
                  <Surface as="ul" bleed className={styles.dealList} data-testid="card-deals">
                    {card.deals.map((deal) => (
                      <DealRow key={deal.contract_id} deal={deal} onNavigate={onNavigate} />
                    ))}
                  </Surface>
                )}
              </section>
              </>
            )}
            {/* Пояснение внизу — ОДНО на экран: две системы оценки по роли
                и правило цвета полосы (ADR-163 §1/§3). Без него зоны
                читались бы как оценка платформы, а не как арифметика.
                На стартовой карточке его нет: объяснять нечего, полос там
                не показано ни одной. */}
            {card.restricted ? null : (
              <p className={styles.legendFooter} data-testid="card-legend">
                {t('reputation.rolesExplainer')}
              </p>
            )}
          </div>
        </div>
      </div>

      <ProjectViewModal project={viewingWork} onClose={() => setViewingWork(null)} />
      <Modal
        open={avatarOpen}
        title={t('reputation.expandAvatar')}
        onClose={() => setAvatarOpen(false)}
        closeLabel={t('common.close')}
      >
        {card.avatar_url ? (
          <img
            src={card.avatar_url}
            alt={t('profile.avatarAlt')}
            style={{ width: '100%', borderRadius: 12 }}
            data-testid="avatar-lightbox"
          />
        ) : null}
      </Modal>
      <Modal open={shareOpen} title={t('reputation.shareTitle')} onClose={() => setShareOpen(false)} closeLabel={t('common.close')}>
        <div className={styles.shareBody}>
          <label className={styles.shareField}>
            <span>{t('reputation.qrLinkLabel')}</span>
            <input type="text" readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} />
          </label>
        </div>
      </Modal>
    </div>
  );
}

/** Легенда зон у заголовка блока (ADR-163 §3) — три точки-образца с
 * подписями. Без неё цвет полосы приходилось бы угадывать. */
function ZoneLegend(): JSX.Element {
  const { t } = useTranslation();
  return (
    <p className={styles.zoneLegend} data-testid="zone-legend">
      <span className={`${styles.zoneDot} ${styles.zoneRed}`} aria-hidden="true" />
      <span className={`${styles.zoneDot} ${styles.zoneAmber}`} aria-hidden="true" />
      <span className={`${styles.zoneDot} ${styles.zoneGreen}`} aria-hidden="true" />
      <span className={styles.zoneLegendText}>{t('reputation.zoneLegend')}</span>
    </p>
  );
}

/** Сноска-подсказка со значком «?»: какая именно ось нарисована полосой в
 * ЭТОМ разделе. Раскрывается по нажатию — на 360 постоянный текст занял бы
 * больше места, чем сами строки. */
function BarHint({ text }: { text: string }): JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.barHint}>
      <button
        type="button"
        className={styles.barHintBtn}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.barHintMark} aria-hidden="true">
          ?
        </span>
        {t('reputation.hintWhatBar')}
      </button>
      {open ? <p className={styles.barHintText}>{text}</p> : null}
    </div>
  );
}

/** Имена сфер — из публичного каталога (`GET /v1/spheres`); код без имени
 * не прячем, показываем как есть (лучше код, чем пустое место). */
function useSphereName(): (code: string) => string {
  const { data: spheres } = useSpheres('');
  return (code: string): string =>
    [...(spheres?.results ?? []), ...(spheres?.popular ?? [])].find((s) => s.code === code)?.name ??
    code;
}

/** «По сферам и ролям»: ДВЕ поверхности — «как исполнитель» и «как
 * заказчик». Разделять обязательно: в одной сфере человек бывает по обе
 * стороны, и складывать его цифры нельзя (ADR-163 §1). */
function SpheresSection({ card }: { card: ReputationCard }): JSX.Element | null {
  const { t } = useTranslation();
  if (card.restricted || card.by_sphere.length === 0) return null;
  const contractor = card.by_sphere.filter((r) => r.role === 'contractor');
  const customer = card.by_sphere.filter((r) => r.role === 'customer');
  return (
    <div className={styles.numberArea} data-testid="card-spheres-by-role">
      <SectionLabel level={3}>{t('reputation.spheresTitle')}</SectionLabel>
      {/* Легенда — ОТДЕЛЬНОЙ строкой под заголовком, не в `aside`
          SectionLabel: слот справа не сжимается, и на 360 текст легенды
          распирал страницу на 139px (проверка «нет горизонтального
          скролла» это и поймала). */}
      <ZoneLegend />
      <RoleSpheres
        rows={contractor}
        role="contractor"
        deals={card.by_role?.contractor.deals ?? 0}
        title={t('reputation.asContractor', { n: card.by_role?.contractor.deals ?? 0 })}
        hint={t('reputation.hintContractorBar')}
      />
      <RoleSpheres
        rows={customer}
        role="customer"
        deals={card.by_role?.customer.deals ?? 0}
        title={t('reputation.asCustomer', { n: card.by_role?.customer.deals ?? 0 })}
        hint={t('reputation.hintCustomerBar')}
      />
    </div>
  );
}

function RoleSpheres({
  rows,
  role,
  deals,
  title,
  hint,
}: {
  rows: ReputationSphereStats[];
  role: 'contractor' | 'customer';
  deals: number;
  title: string;
  hint: string;
}): JSX.Element | null {
  const { t } = useTranslation();
  const sphereName = useSphereName();
  if (rows.length === 0 || deals === 0) return null;
  const onTimeKey =
    role === 'contractor' ? 'reputation.statOnTimeDelivery' : 'reputation.statOnTimePayment';
  const ariaKey =
    role === 'contractor' ? 'reputation.onTimeDeliveryLabel' : 'reputation.onTimePaymentLabel';
  return (
    <section className={styles.roleBlock} data-testid={`spheres-${role}`}>
      <p className={styles.roleTitle}>{title}</p>
      <BarHint text={hint} />
      <Surface bleed>
        {rows.map((row) => (
          <SphereRow
            key={`${row.sphere_code}:${row.role}`}
            name={sphereName(row.sphere_code)}
            onTime={row.on_time}
            onTimeLabel={t(onTimeKey, { done: row.on_time.done, total: row.on_time.total })}
            progressAriaLabel={t('reputation.sphereProgressAria', {
              label: t(ariaKey),
              done: row.on_time.done,
              total: row.on_time.total,
            })}
            firstTimeLabel={
              row.first_time.total > 0
                ? t('reputation.statFirstTime', {
                    done: row.first_time.done,
                    total: row.first_time.total,
                  })
                : undefined
            }
            notes={[
              ...(row.disputes > 0 ? [t('reputation.noteDisputes', { n: row.disputes })] : []),
              ...(row.warranty > 0 ? [t('reputation.noteWarranty', { n: row.warranty })] : []),
            ]}
          />
        ))}
      </Surface>
    </section>
  );
}

/** «Надёжность»: споры, гарантийные обращения, повторные контрагенты,
 * последняя сделка — факты, у которых нет «своей» роли. */
function ReliabilitySection({ card }: { card: ReputationCard }): JSX.Element | null {
  const { t } = useTranslation();
  const { formatShortDate } = useFormatters();
  if (card.restricted || !card.by_role) return null;
  const warranty = card.by_role.contractor.warranty_claims + card.by_role.customer.warranty_claims;
  const repeat = card.repeat_counterparties;
  const rows = [
    card.disputes_free && card.disputes_free.total > 0
      ? t('reputation.statDisputesFree', {
          done: card.disputes_free.done,
          total: card.disputes_free.total,
        })
      : null,
    t('reputation.warrantyClaims', { n: warranty }),
    repeat && repeat.total > 0
      ? t('reputation.repeatCounterparties', { count: repeat.count, total: repeat.total })
      : null,
    card.last_deal_at
      ? t('reputation.lastDeal', { date: formatShortDate(card.last_deal_at) })
      : null,
    card.by_role.customer.prompt_acceptance.total > 0
      ? t('reputation.statPromptAcceptance', {
          done: card.by_role.customer.prompt_acceptance.done,
          total: card.by_role.customer.prompt_acceptance.total,
        })
      : null,
  ].filter((v): v is string => !!v);
  if (rows.length === 0) return null;
  return (
    <div className={styles.numberArea} data-testid="card-reliability">
      <SectionLabel level={3}>{t('reputation.reliabilityTitle')}</SectionLabel>
      <Surface bleed>
        {rows.map((row) => (
          <p key={row} className={styles.reliabilityRow}>
            {row}
          </p>
        ))}
      </Surface>
    </div>
  );
}

/** Плитка-доля: полоса зонного цвета + дробь. `null`/`total: 0` — «нечего
 * мерить», полосы нет вовсе (это НЕ красная зона, ADR-163 §2). */
function RatioTile({
  ratio,
  label,
  statLabel,
  hidden,
  hiddenLabel,
  emptyLabel,
}: {
  ratio: CountRatio | null;
  label: string;
  statLabel: (ratio: CountRatio) => string;
  hidden: boolean;
  hiddenLabel: string;
  emptyLabel: string;
}): JSX.Element {
  return (
    <div className={styles.stat}>
      {hidden || !ratio || ratio.total === 0 ? (
        <span className={styles.statHidden}>{hidden ? hiddenLabel : emptyLabel}</span>
      ) : (
        <ZoneBar
          ratio={ratio}
          label={statLabel(ratio)}
          ariaLabel={`${label}: ${statLabel(ratio)}`}
        />
      )}
      <span className={styles.statLabel}>{label}</span>
    </div>
  );
}

function Stat({
  value,
  label,
  hidden,
  hiddenLabel,
}: {
  value: number | null;
  label: string;
  hidden: boolean;
  hiddenLabel: string;
}): JSX.Element {
  return (
    <div className={styles.stat}>
      <span className={styles.statValue}>
        {hidden || value === null ? <span className={styles.statHidden}>{hiddenLabel}</span> : <LtrText as="span">{String(value)}</LtrText>}
      </span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  );
}

function DealRow({ deal, onNavigate }: { deal: ReputationDealFact; onNavigate: (to: string) => void }): JSX.Element {
  const { t } = useTranslation();
  const { formatShortDate } = useFormatters();
  const sphereName = useSphereName();

  const period = [deal.period_start, deal.period_end]
    .filter((v): v is string => !!v)
    .map((v) => formatShortDate(v))
    .join(' — ');

  return (
    <li className={styles.deal}>
      <div className={styles.dealHead}>
        {contractTypeLabelKey(deal.contract_type_code) ? (
          <Badge tone="ink">{t(contractTypeLabelKey(deal.contract_type_code) ?? '')}</Badge>
        ) : null}
        <Badge tone="neutral">{t(`segment.${deal.segment}`, { defaultValue: deal.segment })}</Badge>
        {/* Исход — статусом СЛОВОМ-цветом (ADR-152), а не третьим чипом
            подряд: два бейджа и чип статуса в одной полосе на 360px
            переносились по одному в строку. */}
        {deal.outcome === 'completed' ? <StatusWord label={t('reputation.outcomeCompleted')} tone="green" /> : null}
      </div>
      {deal.sphere_codes.length > 0 ? (
        <div className={styles.dealSpheres}>
          {deal.sphere_codes.map((code) => (
            <span key={code} className={styles.sphereChip}>
              {sphereName(code)}
            </span>
          ))}
        </div>
      ) : null}
      <div className={styles.dealMeta}>
        {period ? <span>{t('reputation.dealPeriod', { period })}</span> : null}
        {deal.completed_at ? <span>{t('reputation.dealCompletedAt', { date: formatShortDate(deal.completed_at) })}</span> : null}
      </div>
      <div className={styles.dealMeta}>
        <span>{t('reputation.dealMilestonesAccepted', { n: deal.milestones_accepted })}</span>
        {deal.milestones_rejected > 0 ? <span>{t('reputation.dealMilestonesRejected', { n: deal.milestones_rejected })}</span> : null}
        {deal.disputes_opened > 0 ? (
          <span>{t('reputation.dealDisputes', { opened: deal.disputes_opened, resolved: deal.disputes_resolved })}</span>
        ) : null}
      </div>
      {deal.counterparty ? (
        <button
          type="button"
          className={styles.linkBtn}
          onClick={() => onNavigate(`/reputation/profiles/${deal.counterparty?.profile_id}`)}
        >
          {t(deal.counterparty.role === 'customer' ? 'reputation.counterpartyCustomer' : 'reputation.counterpartyContractor')}
        </button>
      ) : null}
    </li>
  );
}
