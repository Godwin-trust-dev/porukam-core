import { useEffect, useMemo, useRef, useState } from 'react';
import { useBlocker, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@porukam/core';
import type { WorkArea } from '@porukam/core';
import { Button, FieldHelp, Modal, ProfileAvatar, SelectField, Skeleton, TextField } from '@porukam/ui';
import { useCurrentUser } from '../../features/auth/useAuth';
import {
  findOwnPersonProfileId,
  useHandleAvailability,
  useClaimHandle,
  useOwnProfileSettings,
  useRemoveAvatar,
  useUpdateOwnProfileSettings,
  useUpdateProfile,
  useUploadAvatar,
} from '../../features/profile/api';
import { useReplaceWorkAreas, useWorkAreas } from '../../features/profile/workAreaApi';
import { toWriteItem } from '../../features/profile/workAreaHelpers';
import { WorkAreaEditor } from '../../features/profile/WorkAreaEditor';
import styles from './ProfileSettingsPage.module.css';
import { COUNTRY_CODES, countryName } from '../../features/groups/groupLabels';
import { SphereChipsEditor } from '../../features/profile/SphereChipsEditor';
import { WorkTypeChipsEditor, PROFILE_MAX_WORK_TYPES } from '../../features/profile/WorkTypeChipsEditor';

const HANDLE_RE = /^@[a-zA-Z0-9_]{3,20}$/;

function buildSchema(t: (key: string) => string) {
  return z.object({
    display_name: z.string().trim().min(1, t('profile.formNameRequired')),
    handle: z.string().trim().regex(HANDLE_RE, t('profile.formHandleInvalid')),
    // Свободная подпись для посёлков вне справочника (ADR-182 «works_remotely/
    // city_name — наследие, срок жизни известен») — НЕ география поиска,
    // геозона поиска теперь — отдельный блок WorkAreaEditor ниже.
    city: z.string().optional(),
    country: z.string().optional(),
  });
}
type FormValues = z.infer<ReturnType<typeof buildSchema>>;

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Настройки → профиль (DEV-02 §5, ADR-087) — реальный контракт (docs/tasks/
 * Задача_fix_web-profile-settings-real-api.md):
 * - `display_name` → `PATCH /users/me` (apps.accounts, ADR-086).
 * - `handle` → `POST /users/me/handle` (apps.social, `useClaimHandle` —
 *   как в онбординге, НЕ через `PATCH /users/me`, тот `handle` игнорирует).
 * - `city` (свободная подпись) → `PATCH /profiles/{id}` (apps.profiles).
 * - регион работы (масштаб «весь мир»/страна/регион/город, план 11.09 §4,
 *   ADR-182) → `PUT /profiles/{id}/work-areas`, ОТДЕЛЬНЫЙ эндпоинт, не
 *   поле профиля. ЗАМЕНИЛ галочку «Работаю удалённо» (`works_remotely`) —
 *   та больше НЕ выставляется отсюда (поле осталось на бэке как наследие,
 *   ADR-182 «works_remotely/city_name»).
 * «О себе»/загрузка аватара/сферы — УБРАНЫ (Tier B, ADR-087 «Отложено»): на
 * боевом бэке для них нет ни полей, ни эндпоинтов вообще — раньше молча не
 * сохранялись, теперь просто не показаны, честнее «битого» UI.
 */
export function ProfileSettingsPage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { data: me, isPending: mePending } = useCurrentUser();
  const profileId = findOwnPersonProfileId(me?.profiles);
  const { data: profile, isPending: profilePending } = useOwnProfileSettings(profileId);
  const updateProfile = useUpdateProfile();
  const claimHandle = useClaimHandle();
  const updateProfileSettings = useUpdateOwnProfileSettings(profileId);
  const uploadAvatar = useUploadAvatar(profileId);
  const removeAvatar = useRemoveAvatar(profileId);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  // ADR-122: заявленные сферы — вне react-hook-form (список чипов), уходят тем же PATCH /profiles/{id}.
  const [spheres, setSpheres] = useState<string[]>([]);
  const [spheresDirty, setSpheresDirty] = useState(false);
  // ADR-190/191: виды работ — составные коды `<сфера>.<категория>`, тем же
  // PATCH, полем `work_type_codes`. Живут рядом со сферами (не в react-hook-form
  // тоже), т.к. набор видов работ зависит от набора сфер — см. `onChange`
  // `SphereChipsEditor` ниже (снятие сферы сразу режет её виды работ).
  const [workTypes, setWorkTypes] = useState<string[]>([]);
  const [workTypesDirty, setWorkTypesDirty] = useState(false);
  const [workTypesSaveError, setWorkTypesSaveError] = useState<string | null>(null);
  // Регион работы (ADR-182) — тоже вне react-hook-form: свой эндпоинт
  // (PUT /profiles/{id}/work-areas), не поле PATCH /profiles/{id}.
  const { data: workAreasData, isPending: workAreasPending } = useWorkAreas(profileId);
  const replaceWorkAreas = useReplaceWorkAreas(profileId);
  const [workAreas, setWorkAreas] = useState<WorkArea[]>([]);
  const [workAreasDirty, setWorkAreasDirty] = useState(false);
  const [workAreaSaveError, setWorkAreaSaveError] = useState<string | null>(null);
  const schema = useMemo(() => buildSchema(t), [t]);

  // Фото (ADR-103) — отдельная мутация, не часть формы: сохраняется сразу
  // по выбору файла (как «сохранено» на бэке), форма/isDirty не трогаются.
  async function onAvatarPicked(file: File | undefined): Promise<void> {
    if (!file) return;
    setAvatarError(null);
    try {
      await uploadAvatar.mutateAsync(file);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'avatar_too_large') setAvatarError(t('profile.avatarTooLarge'));
      else if (err instanceof ApiError && err.code === 'invalid_avatar_image') setAvatarError(t('profile.avatarInvalid'));
      else throw err;
    } finally {
      // Тот же файл повторно — иначе onChange не сработает.
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  const [justSaved, setJustSaved] = useState(false);
  const [initialized, setInitialized] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    setError,
    clearErrors,
    reset,
    formState: { errors, isDirty, isValid },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    mode: 'onChange',
    defaultValues: { display_name: '', handle: '', city: '', country: '' },
  });

  // Ждём ВСЕ источники (me — display_name/handle из apps.accounts/apps.social;
  // profile — city из apps.profiles, ADR-087; workAreasData — регион работы,
  // ADR-182) — один `reset`, не несколько подряд (иначе поздний затирал бы
  // несохранённую правку раннего поля).
  useEffect(() => {
    if (!me || !profile || workAreasData === undefined || initialized) return;
    reset({
      display_name: me.display_name,
      handle: me.handle ?? '',
      city: profile.city_name,
      country: me.country_code ?? '',
    });
    setSpheres(profile.sphere_codes ?? []);
    setWorkTypes(profile.work_type_codes ?? []);
    setWorkAreas(workAreasData);
    setInitialized(true);
  }, [me, profile, workAreasData, initialized, reset]);

  const handleValue = watch('handle');
  const debouncedHandle = useDebounced(handleValue, 400);
  const handleChanged = Boolean(me) && debouncedHandle !== me?.handle && HANDLE_RE.test(debouncedHandle ?? '');
  const { data: availability, isFetching: checkingHandle } = useHandleAvailability(handleChanged ? debouncedHandle : '');

  const hasUnsaved = isDirty || spheresDirty || workTypesDirty || workAreasDirty;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => hasUnsaved && currentLocation.pathname !== nextLocation.pathname);

  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent): void {
      if (!hasUnsaved) return;
      e.preventDefault();
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnsaved]);

  const saving = updateProfile.isPending || claimHandle.isPending || updateProfileSettings.isPending || replaceWorkAreas.isPending;

  async function onSubmit(values: FormValues): Promise<void> {
    if (handleChanged && availability && !availability.available) return;
    clearErrors('handle');
    setWorkAreaSaveError(null);
    setWorkTypesSaveError(null);

    if (handleChanged) {
      try {
        // Хендл — ОТДЕЛЬНО и ПЕРВЫМ (POST /users/me/handle, apps.social):
        // занят/невалиден → ошибка инлайн, остальные поля не отправлены —
        // шаг не «полусохраняется» (тот же приём, что ProfileStepPage онбординга).
        await claimHandle.mutateAsync(values.handle.replace(/^@/, ''));
      } catch (err) {
        if (err instanceof ApiError && err.code === 'handle_taken') {
          setError('handle', { message: t('profile.formHandleTaken') });
          return;
        }
        if (err instanceof ApiError && err.code === 'invalid_handle_format') {
          setError('handle', { message: t('profile.formHandleInvalid') });
          return;
        }
        throw err;
      }
    }

    try {
      await Promise.all([
        // ADR-121: страна — география человека для зон поиска (User.country_code,
        // PATCH /users/me); пустой выбор сбрасывает страну (null → контур GLOBAL).
        // ADR-182: страна — это ТОЛЬКО применимое право, не адрес и не поиск.
        updateProfile.mutateAsync({ display_name: values.display_name, country_code: values.country || null }),
        updateProfileSettings.mutateAsync({ city_name: values.city ?? '', sphere_codes: spheres, work_type_codes: workTypes }),
        // Регион работы — полная идемпотентная замена (ADR-182), клиент уже
        // отсёк дубли/лимит в WorkAreaEditor, но гонка (второе устройство/
        // вкладка) всё ещё может прилететь 422 с сервера — обрабатываем ниже.
        replaceWorkAreas.mutateAsync(workAreas.map(toWriteItem)),
      ]);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'work_area_limit') {
        setWorkAreaSaveError(t('profile.workArea.limit'));
        return;
      }
      if (err instanceof ApiError && err.code === 'work_area_duplicate') {
        setWorkAreaSaveError(t('profile.workArea.duplicate'));
        return;
      }
      // ADR-190/191: та же гонка, что у региона работы, здесь — с составом
      // видов работ (два устройства/вкладки), сервер уже отсёк невалидное.
      if (err instanceof ApiError && err.code === 'profile_work_types_limit') {
        setWorkTypesSaveError(t('profile.workType.limit'));
        return;
      }
      if (err instanceof ApiError && err.code === 'work_type_sphere_not_declared') {
        setWorkTypesSaveError(t('profile.workType.sphereNotDeclared'));
        return;
      }
      if (err instanceof ApiError && err.code === 'invalid_work_type') {
        setWorkTypesSaveError(t('profile.workType.invalid'));
        return;
      }
      throw err;
    }
    reset(values);
    setSpheresDirty(false);
    setWorkTypesDirty(false);
    setWorkAreasDirty(false);
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 2500);
  }

  if (mePending || profilePending || workAreasPending || !me || !profile || !initialized) {
    return (
      <div className={styles.wrap}>
        <Skeleton width={96} height={96} radius="50%" />
        <Skeleton width="60%" height={24} />
        <Skeleton width="100%" height={120} />
      </div>
    );
  }

  return (
    <form className={styles.wrap} onSubmit={(e) => void handleSubmit(onSubmit)(e)}>
      <div className={styles.avatarRow}>
        <ProfileAvatar
          handle={me.handle ?? 'user'}
          name={me.display_name}
          src={profile.avatar_url ?? undefined}
          alt={profile.avatar_url ? t('profile.avatarAlt') : undefined}
          size={88}
        />
        <div className={styles.avatarActions}>
          <div className={styles.avatarButtons}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className={styles.fileInput}
              data-testid="avatar-file-input"
              aria-label={t('profile.avatarChange')}
              onChange={(e) => void onAvatarPicked(e.target.files?.[0])}
            />
            <Button
              type="button"
              variant="secondary"
              loading={uploadAvatar.isPending}
              disabled={removeAvatar.isPending}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploadAvatar.isPending ? t('profile.avatarUploading') : t('profile.avatarChange')}
            </Button>
            {profile.avatar_url ? (
              <Button
                type="button"
                variant="ghost"
                loading={removeAvatar.isPending}
                disabled={uploadAvatar.isPending}
                onClick={() => {
                  setAvatarError(null);
                  removeAvatar.mutate();
                }}
              >
                {t('profile.avatarRemove')}
              </Button>
            ) : null}
          </div>
          <span className={styles.avatarHelp}>
            <FieldHelp label={t('hints.helpButton')}>{t('hints.settings.avatar')}</FieldHelp>
          </span>
          {avatarError ? (
            <span className={styles.avatarError} role="alert" data-testid="avatar-error">
              {avatarError}
            </span>
          ) : (
            <span className={styles.avatarHint}>{t('profile.avatarHint')}</span>
          )}
        </div>
      </div>

      <TextField
        label={t('profile.formNameLabel')} help={t('hints.settings.displayName')} helpLabel={t('hints.helpButton')}
        error={errors.display_name?.message}
        {...register('display_name')}
      />

      <div className={styles.handleField}>
        <TextField
          label={t('profile.formHandleLabel')}
          hint={t('profile.formHandleHint')}
          help={t('hints.settings.handle')}
          helpLabel={t('hints.helpButton')}
          error={errors.handle?.message}
          {...register('handle')}
        />
        {handleChanged && !errors.handle ? (
          <span className={styles.handleStatus} data-testid="handle-availability">
            {checkingHandle
              ? t('profile.formHandleChecking')
              : availability
                ? availability.available
                  ? t('profile.formHandleAvailable')
                  : t('profile.formHandleTaken')
                : // `/users/handle-available` на боевом бэке нет (см. useHandleAvailability):
                  // нет ответа — статус неизвестен, а НЕ «занят»; истина — 409 при сабмите.
                  null}
          </span>
        ) : null}
      </div>

      {/* Страна = применимое право (ADR-182), НЕ адрес проживания и НЕ
          география поиска заказов — `hint` говорит об этом прямо рядом с
          полем, `help` (значок подсказки) — то же самое подробнее. */}
      <SelectField
        label={t('profile.formCountryLabel')}
        hint={t('profile.formCountryJurisdictionNote')}
        help={t('hints.settings.country')}
        helpLabel={t('hints.helpButton')}
        {...register('country')}
        data-testid="profile-country"
      >
        <option value="">—</option>
        {COUNTRY_CODES.map((code) => ({ code, name: countryName(code, i18n.language) }))
          .sort((a, b) => a.name.localeCompare(b.name, i18n.language))
          .map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
      </SelectField>

      {/* Свободная подпись для городов/посёлков вне справочника apps.geo
          (ADR-182 «works_remotely/city_name — наследие») — оставлена, но
          честно подписана: в поиске больше не участвует, для поиска ниже
          отдельный блок «Где я работаю» (WorkAreaEditor). Убирать поле
          совсем не стали — у части людей это единственный способ назвать
          свой посёлок хоть как-то на карточке. */}
      <TextField
        label={t('profile.formCityLabel')}
        hint={t('profile.formCityCaptionHint')}
        help={t('hints.settings.city')}
        helpLabel={t('hints.helpButton')}
        {...register('city')}
      />

      {/* Регион работы (план 11.09 §4, ADR-182) — ЗАМЕНИЛ галочку «Работаю
          удалённо»: «весь мир» теперь один из масштабов, наравне со
          страной/регионом/городом, а не отдельный переключатель. */}
      <WorkAreaEditor
        value={workAreas}
        onChange={(next) => {
          setWorkAreas(next);
          setWorkAreasDirty(true);
          setWorkAreaSaveError(null);
        }}
        hint={t('profile.workArea.hint')}
      />
      {workAreaSaveError ? (
        <p role="alert" className={styles.avatarError} data-testid="work-area-save-error">
          {workAreaSaveError}
        </p>
      ) : null}

      <SphereChipsEditor
        value={spheres}
        onChange={(codes) => {
          setSpheres(codes);
          setSpheresDirty(true);
          // ADR-190/191: снятие сферы сразу режет её виды работ — человек
          // видит это немедленно, не только после «Сохранить» (бэк лишние
          // коды и так отсечёт сам при PATCH, ADR-190 §2, но экран не должен
          // молча показывать чипы, которые на самом деле уже не сохранятся).
          setWorkTypes((codesOfWorkTypes) => codesOfWorkTypes.filter((c) => codes.includes(c.split('.')[0] ?? '')));
        }}
        hint={t('profile.formSpheresHint')}
      />

      <WorkTypeChipsEditor
        spheres={spheres}
        value={workTypes}
        onChange={(codes) => {
          setWorkTypes(codes);
          setWorkTypesDirty(true);
        }}
        hint={t('profile.workType.hint')}
        max={PROFILE_MAX_WORK_TYPES}
      />
      {workTypesSaveError ? (
        <p role="alert" className={styles.avatarError} data-testid="work-types-save-error">
          {workTypesSaveError}
        </p>
      ) : null}

      {/* Рамки вокруг группы полей нет (замечание 03.09 «компактнее»):
          портфолио — такая же строка hairline. */}
      <div className={styles.portfolioCard}>
        <span>{t('profile.formPortfolioSummary', { count: 0 })}</span>
        <button type="button" className={styles.portfolioLink} onClick={() => navigate('/me/portfolio')}>
          {t('profile.formPortfolioManage')}
        </button>
      </div>

      <div className={styles.footer}>
        <Button
          type="submit"
          variant="primary"
          block
          loading={saving}
          disabled={!isValid || (handleChanged && availability?.available === false)}
        >
          {t('profile.save')}
        </Button>
        {justSaved ? <span className={styles.savedNote}>{t('profile.saved')}</span> : null}
      </div>

      <Modal
        open={blocker.state === 'blocked'}
        title={t('profile.unsavedTitle')}
        onClose={() => {
          if (blocker.state === 'blocked') blocker.reset();
        }}
        closeLabel={t('common.close')}
        actions={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                if (blocker.state === 'blocked') blocker.reset();
              }}
            >
              {t('profile.unsavedStay')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (blocker.state === 'blocked') blocker.proceed();
              }}
            >
              {t('profile.unsavedLeave')}
            </Button>
          </>
        }
      >
        <p>{t('profile.unsavedText')}</p>
      </Modal>
    </form>
  );
}
