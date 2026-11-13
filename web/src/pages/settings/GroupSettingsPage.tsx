import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ApiError, type Group } from '@porukam/core';
import { Badge, Button, Callout, Card, EmptyState, FieldHelp, Icon, Skeleton, TextField } from '@porukam/ui';
import { useActorStore } from '../../features/actor/actorStore';
import {
  type GroupFormInput,
  useGroup,
  useRemoveGroupLogo,
  useSetGroupHandle,
  useUpdateGroup,
  useUploadGroupLogo,
} from '../../features/groups/api';
import { GroupForm, type GroupFormErrors, normalizeLinks, validateGroupForm } from '../../features/groups/GroupForm';
import { apiErrorText } from '../../shared/apiErrorText';
import styles from './GroupSettingsPage.module.css';

/**
 * Настройки → «Объединение» (ADR-129): раздел настроек АКТИВНОГО актёра-объединения.
 *
 * Сюда переехали витрина, логотип и смена хендла — раньше они жили панелью
 * управления прямо в публичной карточке `/groups/{id}` (замечание 2026-08-25:
 * «смену логотипа и хендла отправляем в настройки, оставляем только
 * пригласить»). Карточка — витрина для читателя, настройки — рабочее место
 * владельца; смешивать их в одном экране было неверно.
 *
 * Раздел показывается только когда в переключателе выбрано объединение:
 * настройки принадлежат актёру, а не странице.
 */
export function GroupSettingsPage(): JSX.Element {
  const { t } = useTranslation();
  const activeGroupId = useActorStore((s) => s.activeGroupId);
  const { data: group, isPending, error } = useGroup(activeGroupId ?? undefined);
  const [err, setErr] = useState<string | null>(null);

  if (!activeGroupId) {
    return <EmptyState icon="share" title={t('dashboard.groupEditTitle')} text={t('dashboard.groupSettingsEmpty')} />;
  }
  if (isPending) return <Skeleton height={320} />;
  if (error || !group) {
    return <EmptyState icon="share" title={t('dashboard.groupNotFoundTitle')} text={t('dashboard.groupNotFoundText')} />;
  }

  return (
    <div className={styles.wrap} data-testid="group-settings">
      <div className={styles.head}>
        <h2 className={styles.title}>{group.name}</h2>
        <Link to={`/groups/${group.id}`} className={styles.openCard} data-testid="group-settings-open-card">
          {t('dashboard.groupSettingsOpenCard')}
        </Link>
      </div>
      <Callout tone="neutral">{t('dashboard.groupSettingsIntro')}</Callout>
      {err ? <Callout tone="warn">{err}</Callout> : null}

      <LogoSection group={group} onError={setErr} />
      <HandleSection group={group} />
      <ShowcaseSection group={group} onError={setErr} />
    </div>
  );
}

/** Логотип объединения (ADR-117 §8) — тот же пайплайн, что аватар профиля. */
function LogoSection({ group, onError }: { group: Group; onError: (msg: string | null) => void }): JSX.Element {
  const { t } = useTranslation();
  const uploadLogo = useUploadGroupLogo(group.id);
  const removeLogo = useRemoveGroupLogo(group.id);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onLogoPicked(file: File | undefined): Promise<void> {
    if (!file) return;
    onError(null);
    try {
      await uploadLogo.mutateAsync(file);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'logo_too_large') onError(t('dashboard.groupLogoTooLarge'));
      else if (e instanceof ApiError && e.code === 'invalid_logo_image') onError(t('dashboard.groupLogoInvalid'));
      else onError(apiErrorText(e) ?? String(e));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <Card>
      <h3 className={styles.sectionTitle}>{t('dashboard.groupSettingsLogoTitle')}</h3>
      <div className={styles.row}>
        {group.logo_url ? (
          <img src={group.logo_url} alt={t('dashboard.groupLogoAlt')} className={styles.logo} data-testid="group-settings-logo" />
        ) : (
          <span className={styles.logoEmpty} aria-hidden="true">
            <Icon name="share" size={24} />
          </span>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          data-testid="group-logo-input"
          aria-label={t('dashboard.groupLogoChange')}
          onChange={(e) => void onLogoPicked(e.target.files?.[0])}
        />
        <Button variant="secondary" loading={uploadLogo.isPending} disabled={removeLogo.isPending} onClick={() => fileRef.current?.click()}>
          {uploadLogo.isPending ? t('dashboard.groupLogoUploading') : t('dashboard.groupLogoChange')}
        </Button>
        {group.logo_url ? (
          <Button
            variant="ghost"
            loading={removeLogo.isPending}
            disabled={uploadLogo.isPending}
            onClick={() => void removeLogo.mutateAsync().catch((e: unknown) => onError(apiErrorText(e) ?? String(e)))}
          >
            {t('dashboard.groupLogoRemove')}
          </Button>
        ) : null}
        <span className={styles.helpCell}>
          <FieldHelp label={t('hints.helpButton')}>{t('hints.group.logo')}</FieldHelp>
        </span>
      </div>
    </Card>
  );
}

/** Смена хендла (ADR-117 §5): один хендл на объединение, 409 `handle_taken`. */
function HandleSection({ group }: { group: Group }): JSX.Element {
  const { t } = useTranslation();
  const setHandle = useSetGroupHandle(group.id);
  const [draft, setDraft] = useState('');
  const [handleError, setHandleError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!saved) return;
    const id = window.setTimeout(() => setSaved(false), 2500);
    return () => window.clearTimeout(id);
  }, [saved]);

  async function change(): Promise<void> {
    setHandleError(null);
    try {
      await setHandle.mutateAsync(draft.trim().replace(/^@/, ''));
      setDraft('');
      setSaved(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'handle_taken') setHandleError(t('dashboard.groupHandleTaken'));
      else if (e instanceof ApiError && e.code === 'invalid_handle') setHandleError(t('dashboard.groupHandleInvalid'));
      else setHandleError(apiErrorText(e) ?? String(e));
    }
  }

  return (
    <Card>
      <h3 className={styles.sectionTitle}>{t('dashboard.groupHandleChangeTitle')}</h3>
      {group.handle ? (
        <p className={styles.current} data-testid="group-settings-handle">
          {group.handle}
        </p>
      ) : null}
      <div className={styles.row}>
        <TextField
          label={t('dashboard.groupHandleLabel')}
          placeholder="@"
          hint={t('dashboard.groupHandleHint')}
          help={t('hints.group.handle')}
          helpLabel={t('hints.helpButton')}
          error={handleError ?? undefined}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          data-testid="group-handle-input"
        />
        <Button
          variant="secondary"
          disabled={!draft.trim()}
          loading={setHandle.isPending}
          onClick={() => void change()}
          data-testid="group-handle-save"
        >
          {t('dashboard.groupHandleSave')}
        </Button>
        {saved ? <Badge tone="green">{t('dashboard.groupSaved')}</Badge> : null}
      </div>
    </Card>
  );
}

function formFromGroup(g: Group): GroupFormInput {
  return {
    kind: g.kind,
    name: g.name,
    description: g.description,
    sphere_code: g.sphere_code,
    geo_scope: g.geo_scope,
    country_code: g.country_code,
    city_name: g.city_name,
    links: g.links,
    is_public: g.is_public,
    join_policy: g.join_policy,
  };
}

/** Витрина объединения (`PATCH /groups/{id}`) — форма прямо на странице, без модалки. */
function ShowcaseSection({ group, onError }: { group: Group; onError: (msg: string | null) => void }): JSX.Element {
  const { t } = useTranslation();
  const update = useUpdateGroup(group.id);
  const [value, setValue] = useState<GroupFormInput>(() => formFromGroup(group));
  const [errors, setErrors] = useState<GroupFormErrors>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!saved) return;
    const id = window.setTimeout(() => setSaved(false), 2500);
    return () => window.clearTimeout(id);
  }, [saved]);

  async function submit(): Promise<void> {
    const nextErrors = validateGroupForm(value);
    setErrors(nextErrors);
    onError(null);
    if (Object.keys(nextErrors).length > 0) return;
    try {
      await update.mutateAsync({
        ...value,
        name: value.name.trim(),
        description: value.description.trim(),
        links: normalizeLinks(value.links),
      });
      setSaved(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_sphere') setErrors({ sphere: 'dashboard.groupSphereRequired' });
      else if (e instanceof ApiError && e.code === 'invalid_geo') setErrors({ geo: 'dashboard.groupGeoInvalid' });
      else onError(apiErrorText(e) ?? String(e));
    }
  }

  return (
    <Card>
      <h3 className={styles.sectionTitle}>{t('dashboard.groupSettingsShowcase')}</h3>
      {!group.sphere_code ? <Callout tone="warn">{t('dashboard.groupSphereFillHint')}</Callout> : null}
      <GroupForm value={value} onChange={(patch) => setValue((v) => ({ ...v, ...patch }))} errors={errors} />
      <div className={styles.row}>
        <Button variant="primary" loading={update.isPending} onClick={() => void submit()} data-testid="group-edit-submit">
          {t('profile.save')}
        </Button>
        {saved ? <Badge tone="green">{t('dashboard.groupSaved')}</Badge> : null}
      </div>
    </Card>
  );
}
