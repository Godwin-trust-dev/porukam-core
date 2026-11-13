import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, type Group } from '@porukam/core';
import {
  Button,
  Callout,
  EmptyState,
  ErrorState,
  HandleField,
  Modal,
  SearchResultRow,
  SectionLabel,
  Skeleton,
  Surface,
} from '@porukam/ui';
import { useAuthStore } from '../features/auth/authStore';
import { type GroupFormInput, useCreateGroup, useGroups } from '../features/groups/api';
import { EMPTY_GROUP_FORM, GroupForm, type GroupFormErrors, normalizeLinks, validateGroupForm } from '../features/groups/GroupForm';
import { groupKindLabelKey } from '../features/groups/groupLabels';
import { apiErrorText } from '../shared/apiErrorText';
import searchStyles from './SearchPage.module.css';
import rowStyles from './GroupsPage.module.css';

const HANDLE_RE = /^[a-zA-Z0-9_]{3,20}$/;

/** `/groups` — публичные объединения + создание своего (отсмотр 2026-08-23;
 * v2 — ADR-117/118: тип из книги, сфера, хендл при создании, география, ссылки).
 *
 * Строка — общая `SearchResultRow` (ADR-152, замечание владельца 03.09
 * «объединения тоже сразу проверь на дизайн»): название первой строкой,
 * «@хендл · тип · участники» — второй, политика входа словом-цветом в её
 * конце. Бейджи, которые на телефоне наезжали на хендл и переносились
 * третьей полосой, убраны. */
export function GroupsPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const { data, isPending, error, refetch } = useGroups();
  const create = useCreateGroup();
  const [createOpen, setCreateOpen] = useState(false);

  const mine = (data ?? []).filter((g) => g.my_membership?.status === 'active');
  const others = (data ?? []).filter((g) => g.my_membership?.status !== 'active');

  const row = (g: Group): JSX.Element => (
    <SearchResultRow
      key={g.id}
      name={g.name}
      handle={g.handle}
      avatarSrc={g.logo_url || undefined}
      meta={
        <>
          <span>{t(groupKindLabelKey(g.kind))}</span>
          {' · '}
          <span>{t('dashboard.groupMembersCount', { count: g.members_count })}</span>
        </>
      }
      statusLabel={t(g.join_policy === 'open' ? 'dashboard.groupPolicyOpen' : 'dashboard.groupPolicyApproval')}
      statusTone={g.join_policy === 'open' ? 'green' : 'neutral'}
      statusOwnLine
      extra={g.my_membership?.status === 'active' ? <span>{t('dashboard.groupYouAreMember')}</span> : undefined}
      onOpen={() => navigate(`/groups/${g.id}`)}
    />
  );

  let body: JSX.Element;
  if (isPending) {
    body = (
      <div className={rowStyles.loading} aria-busy="true">
        <Skeleton height={54} radius="var(--pr-d-r-surface)" />
        <Skeleton height={54} radius="var(--pr-d-r-surface)" />
      </div>
    );
  } else if (error) {
    body = (
      <ErrorState
        title={t('common.unexpectedErrorTitle')}
        text={apiErrorText(error)}
        code={error instanceof ApiError ? error.code : undefined}
        retryLabel={t('common.retry')}
        onRetry={() => void refetch()}
      />
    );
  } else if (!data || data.length === 0) {
    body = <EmptyState icon="share" title={t('dashboard.groupsEmptyTitle')} text={t('dashboard.groupsEmptyText')} />;
  } else {
    body = (
      <>
        {mine.length > 0 ? (
          <section className={searchStyles.section}>
            <SectionLabel level={3}>{t('dashboard.groupsMine')}</SectionLabel>
            <Surface bleed data-testid="groups-mine">
              {mine.map(row)}
            </Surface>
          </section>
        ) : null}
        {others.length > 0 ? (
          <section className={searchStyles.section}>
            {mine.length > 0 ? <SectionLabel level={3}>{t('dashboard.groupsAll')}</SectionLabel> : null}
            <Surface bleed data-testid="groups-list">
              {others.map(row)}
            </Surface>
          </section>
        ) : null}
      </>
    );
  }

  return (
    <div className={searchStyles.wrap}>
      {/* Отсмотр 2026-08-24: «во вкладке объединения нужно сверху дать комментарий,
          что это такое и зачем» — вводный блок со ссылкой на «Вопросы и ответы». */}
      <Callout tone="neutral" title={t('dashboard.groupsIntroTitle')}>
        {t('dashboard.groupsIntroText')}{' '}
        <Link to="/help/faq" data-testid="groups-intro-faq">
          {t('dashboard.groupsIntroFaq')}
        </Link>
      </Callout>
      {isAuthenticated ? (
        <div className={rowStyles.actions}>
          <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)} data-testid="create-group">
            {t('dashboard.groupsCreate')}
          </Button>
        </div>
      ) : null}
      {body}

      <CreateGroupModal
        open={createOpen}
        pending={create.isPending}
        onClose={() => setCreateOpen(false)}
        onSubmit={(input) =>
          create
            .mutateAsync(input)
            .then((group) => {
              setCreateOpen(false);
              navigate(`/groups/${group.id}`);
              return null;
            })
            .catch((e: unknown) => (e instanceof ApiError ? e : new ApiError(0, { status: 0, title: String(e) })))
        }
      />
    </div>
  );
}

/** Отдельный компонент с собственным состоянием: инлайн-форма в странице со
 * списком теряла фокус ввода на каждый символ (ре-рендер родителя).
 * Хендл — ОБЯЗАТЕЛЕН при создании (ADR-117 §5): раньше был отдельной
 * необязательной кнопкой после создания, и объединения плодились без адреса. */
function CreateGroupModal({
  open,
  pending,
  onClose,
  onSubmit,
}: {
  open: boolean;
  pending: boolean;
  onClose: () => void;
  /** Резолвится в `null` при успехе, в `ApiError` — при отказе бэка (модалка показывает у поля). */
  onSubmit: (input: GroupFormInput & { handle: string }) => Promise<ApiError | null>;
}): JSX.Element {
  const { t } = useTranslation();
  const [value, setValue] = useState<GroupFormInput>(EMPTY_GROUP_FORM);
  const [handle, setHandle] = useState('');
  const [errors, setErrors] = useState<GroupFormErrors>({});
  const [handleError, setHandleError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const handleClean = handle.replace(/^@/, '');
  const handleValid = HANDLE_RE.test(handleClean);

  async function submit(): Promise<void> {
    const nextErrors = validateGroupForm(value);
    setErrors(nextErrors);
    setHandleError(handleValid ? null : t('dashboard.groupHandleInvalid'));
    setServerError(null);
    if (Object.keys(nextErrors).length > 0 || !handleValid) return;
    const err = await onSubmit({ ...value, name: value.name.trim(), description: value.description.trim(), links: normalizeLinks(value.links), handle: handleClean });
    if (!err) return;
    if (err.code === 'handle_taken') setHandleError(t('dashboard.groupHandleTaken'));
    else if (err.code === 'invalid_handle') setHandleError(t('dashboard.groupHandleInvalid'));
    else if (err.code === 'invalid_sphere') setErrors({ sphere: 'dashboard.groupSphereRequired' });
    else if (err.code === 'invalid_geo') setErrors({ geo: 'dashboard.groupGeoInvalid' });
    else setServerError(apiErrorText(err) ?? err.message);
  }

  return (
    <Modal
      open={open}
      title={t('dashboard.groupsCreate')}
      onClose={onClose}
      closeLabel={t('common.close')}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={pending} onClick={() => void submit()} data-testid="create-group-submit">
            {t('dashboard.groupsCreate')}
          </Button>
        </>
      }
    >
      <HandleField
        label={t('dashboard.groupHandleLabel')}
        hint={t('dashboard.groupHandleHint')}
        help={t('hints.group.handle')}
        helpLabel={t('hints.helpButton')}
        value={handle}
        onChange={setHandle}
        status="idle"
        checkingLabel=""
        availableLabel=""
        takenLabel={t('dashboard.groupHandleTaken')}
        error={handleError ?? undefined}
      />
      <GroupForm value={value} onChange={(patch) => setValue((v) => ({ ...v, ...patch }))} errors={errors} />
      {serverError ? <p role="alert" style={{ color: 'var(--pr-danger, #b3261e)' }}>{serverError}</p> : null}
    </Modal>
  );
}
