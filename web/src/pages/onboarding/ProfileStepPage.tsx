import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@porukam/core';
import type { WorkArea } from '@porukam/core';
import { Button, HandleField, ProfileAvatar, Skeleton, TextField, Toggle, type HandleFieldStatus } from '@porukam/ui';
import { useCurrentUser } from '../../features/auth/useAuth';
import {
  findOwnPersonProfileId,
  useClaimHandle,
  useHandleAvailability,
  useOwnProfileSettings,
  useUpdateOwnProfileSettings,
  useUpdateProfile,
} from '../../features/profile/api';
import { useReplaceWorkAreas } from '../../features/profile/workAreaApi';
import { toWriteItem } from '../../features/profile/workAreaHelpers';
import { WorkAreaEditor } from '../../features/profile/WorkAreaEditor';
import styles from './OnboardingLayout.module.css';
import { SphereChipsEditor } from '../../features/profile/SphereChipsEditor';

const HANDLE_RE = /^[a-zA-Z0-9_]{3,20}$/;

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

function suggestHandle(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 20);
}

/**
 * Шаг «Профиль» (ProfileStep, DEV-auth-onboarding §6) — @handle обязателен
 * (нужен для ссылки-приглашения). Живая проверка занятости — `GET
 * /users/handle-available` (мок-only, на боевом бэке не отвечает,
 * см. `useHandleAvailability`) — не блокирует; окончательная проверка —
 * `POST /users/me/handle` (`useClaimHandle`, apps.social,
 * docs/tasks/Задача_fix_web-profile-handle-real-api.md) при сабмите,
 * 409/422 показываются инлайн. Аватар — плейсхолдер от @handle (нет
 * реального Google-фото в моке).
 */
export function ProfileStepPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: me, isPending } = useCurrentUser();
  const updateProfile = useUpdateProfile();
  // Person-профиль уже существует к этому шагу (создан подписчиком apps.profiles
  // на "account.logged_in" при регистрации, ДО онбординга) — id доступен сразу.
  const profileId = findOwnPersonProfileId(me?.profiles);
  const { data: profile, isPending: profilePending } = useOwnProfileSettings(profileId);
  const updateProfileSettings = useUpdateOwnProfileSettings(profileId);
  const claimHandle = useClaimHandle();
  const replaceWorkAreas = useReplaceWorkAreas(profileId);

  const [handle, setHandle] = useState('');
  // ADR-122: сферы деятельности — «хотя бы одну при регистрации» (необязательно, чтобы не ломать вход).
  const [spheres, setSpheres] = useState<string[]>([]);
  // Регион работы (план 11.09 §4, ADR-182) — необязательно на этом шаге
  // (свежий профиль, добавлять нечего): пустой список ниже просто не шлёт
  // `PUT /work-areas` вовсе, чтобы не плодить лишний сетевой вызов.
  const [workAreas, setWorkAreas] = useState<WorkArea[]>([]);
  const [name, setName] = useState('');
  const [showHandleOnly, setShowHandleOnly] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [submitError, setSubmitError] = useState<{ kind: 'taken' | 'invalid'; message: string } | null>(null);

  function onHandleChange(value: string): void {
    setHandle(value);
    setSubmitError(null); // правка после отклонённого сабмита — статус не должен «залипать»
  }

  useEffect(() => {
    // Ждём и `me`, и `profile` (apps.profiles, ADR-087) — `show_name` реально
    // живёт там, не в `me.settings` (того поля больше нет вовсе, ADR-087).
    if (!me || !profile || initialized) return;
    // Краш «Cannot read properties of undefined (reading 'replace')»
    // (docs/tasks/Задача_fix_web-consents-crash.md) — свежий GLOBAL-аккаунт
    // на боевом бэке ЕЩЁ НЕ имеет ни `display_name`, ни `handle` (хендл
    // назначается ИМЕННО этим шагом; `CurrentUser.display_name`/`handle`
    // типизированы как обязательные `string`, но реальный `/v1/users/me`
    // может не отдать их вовсе — мок всегда подставляет `''`, поэтому баг не
    // ловился до реального боевого прохода). `?? ''` — не заглушка ради
    // заглушки: пустая строка здесь и есть корректное начальное состояние
    // (§5 «ничего не предзаполнено», тот же принцип, что согласия).
    const displayName = me.display_name ?? '';
    setName(displayName);
    setHandle((me.handle ?? '').replace(/^@/, '') || suggestHandle(displayName));
    setShowHandleOnly(!profile.show_name);
    setInitialized(true);
  }, [me, profile, initialized]);

  const debouncedHandle = useDebounced(handle, 400);
  const formatValid = HANDLE_RE.test(debouncedHandle);
  const checkEnabled = formatValid && debouncedHandle.length > 0;
  const { data: availability, isFetching: checkingHandle } = useHandleAvailability(checkEnabled ? `@${debouncedHandle}` : '');

  const status: HandleFieldStatus =
    submitError?.kind === 'taken'
      ? 'taken'
      : handle.length === 0
        ? 'idle'
        : checkingHandle
          ? 'checking'
          : availability
            ? availability.available
              ? 'available'
              : 'taken'
            : 'idle';

  const canContinue = handle.length > 0 && formatValid && name.trim().length > 0 && availability?.available !== false && !checkingHandle;

  async function onContinue(): Promise<void> {
    if (!canContinue) return;
    setSubmitError(null);
    try {
      // Хендл — ПЕРВЫМ и ОТДЕЛЬНО (POST /users/me/handle, apps.social):
      // если занят/невалиден — шаг не «полусохраняется» (имя ниже ещё не отправлено).
      await claimHandle.mutateAsync(handle);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'handle_taken') {
        setSubmitError({ kind: 'taken', message: t('onboarding.handleTaken') });
        return;
      }
      if (err instanceof ApiError && err.code === 'invalid_handle_format') {
        setSubmitError({ kind: 'invalid', message: t('onboarding.handleInvalid') });
        return;
      }
      throw err; // неожиданная ошибка — не проглатываем молча
    }
    await updateProfile.mutateAsync({ display_name: name.trim() });
    // Profile.show_name — реальное поле (apps.profiles, ADR-087), PATCH /profiles/{id}.
    // Не критично для продолжения — сеттинг видимости имени, не блокер онбординга.
    try {
      await updateProfileSettings.mutateAsync({ show_name: !showHandleOnly, ...(spheres.length > 0 ? { sphere_codes: spheres } : {}) });
    } catch {
      // Профиль мог ещё не долететь через outbox в редком случае — не блокируем
      // переход дальше, тумблер можно перевключить позже в настройках.
    }
    // Регион работы — необязателен на этом шаге (план 11.09 §4): ничего не
    // выбрано → нечего писать. Как и выше, не блокирует переход дальше —
    // добавить/изменить можно в любой момент в настройках.
    if (workAreas.length > 0) {
      try {
        await replaceWorkAreas.mutateAsync(workAreas.map(toWriteItem));
      } catch {
        // См. комментарий выше про show_name — тот же приём.
      }
    }
    navigate('/onboarding/backup');
  }

  if (isPending || profilePending || !initialized) {
    return (
      <div className={styles.screen} data-density="cozy">
        <div className={styles.wrap} aria-busy="true">
          <Skeleton width="70%" height={32} />
          <Skeleton width={64} height={64} radius="50%" />
          <Skeleton width="100%" height={56} />
          <Skeleton width="100%" height={56} />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.screen} data-density="cozy">
      <div className={styles.wrap}>
        <h1 className={styles.title}>{t('onboarding.profileTitle')}</h1>

        <ProfileAvatar handle={handle || 'user'} name={name} size={64} />

        <HandleField
          label={t('onboarding.handleLabel')} help={t('hints.onboarding.handle')} helpLabel={t('hints.helpButton')}
          hint={t('onboarding.handleHint')}
          placeholder={t('onboarding.handlePlaceholder')}
          value={handle}
          onChange={onHandleChange}
          status={status}
          checkingLabel={t('onboarding.handleChecking')}
          availableLabel={t('onboarding.handleAvailable')}
          takenLabel={t('onboarding.handleTaken')}
          error={submitError?.kind === 'invalid' ? submitError.message : undefined}
        />

        <TextField label={t('onboarding.nameLabel')} help={t('hints.onboarding.name')} helpLabel={t('hints.helpButton')} value={name} onChange={(e) => setName(e.target.value)} />

        <div className={styles.toggleRow}>
          <span className={styles.toggleLabel}>{t('onboarding.handleOnlyToggle')}</span>
          <Toggle
            checked={showHandleOnly}
            onChange={setShowHandleOnly}
            label={t('onboarding.handleOnlyToggle')}
            onLabel={t('common.toggleOn')}
            offLabel={t('common.toggleOff')}
          />
        </div>
        <p className={styles.toggleHint}>{t('onboarding.handleOnlyHint')}</p>

        <SphereChipsEditor value={spheres} onChange={setSpheres} label={t('onboarding.spheresLabel')} hint={t('onboarding.spheresHint')} testId="onboarding-spheres" />

        <WorkAreaEditor
          value={workAreas}
          onChange={setWorkAreas}
          label={t('onboarding.workAreaLabel')}
          hint={t('onboarding.workAreaHint')}
          testId="onboarding-work-areas"
        />

        <Button
          variant="primary"
          block
          onClick={() => void onContinue()}
          loading={claimHandle.isPending || updateProfile.isPending || updateProfileSettings.isPending || replaceWorkAreas.isPending}
          disabled={!canContinue}
          aria-disabled={!canContinue}
        >
          {t('onboarding.continue')}
        </Button>
      </div>
    </div>
  );
}
