import { useTranslation } from 'react-i18next';
import type { AvatarVisibility, ProfileVisibility } from '@porukam/core';
import { SettingRow, Skeleton, Surface } from '@porukam/ui';
import { useCurrentUser } from '../../features/auth/useAuth';
import {
  findOwnPersonProfileId,
  useMyConsents,
  useOwnProfileSettings,
  useRecordConsent,
  useUpdateOwnProfileSettings,
} from '../../features/profile/api';
import styles from './PrivacySettingsPage.module.css';

/**
 * Настройки → приватность (DEV-02 §5, ADR-059 §3, ADR-087) — реальный
 * контракт (docs/tasks/Задача_fix_web-profile-settings-real-api.md): раньше
 * страница писала в несуществующий `PATCH /users/me/settings` и молча НИЧЕГО
 * не сохраняла. Теперь:
 * - `profile_visibility`/`hide_from_catalog`/`show_name`/`avatar_visibility` —
 *   `apps.profiles.Profile`, `PATCH /profiles/{id}` (свой person-профиль).
 * - «Находимость по телефону» — `apps.social.Consent`, `POST /users/me/consents`
 *   (согласие, не поле профиля).
 * Вымышленные поля мока Ф1 без реального бэкенд-контракта (per-field
 * видимость телефона/портфолио, точность города) — убраны, не показаны как
 * рабочие тумблеры (§5 задачи: не оставлять «есть поле — молча не сохраняется»).
 */
export function PrivacySettingsPage(): JSX.Element {
  const { t } = useTranslation();
  const { data: me, isPending: mePending } = useCurrentUser();
  const profileId = findOwnPersonProfileId(me?.profiles);
  const { data: profile, isPending: profilePending } = useOwnProfileSettings(profileId);
  const { data: consents, isPending: consentsPending } = useMyConsents();
  const updateProfile = useUpdateOwnProfileSettings(profileId);
  const recordConsent = useRecordConsent();

  if (mePending || profilePending || consentsPending || !profile || !consents) {
    return (
      <div className={styles.wrap}>
        <Skeleton width="100%" height={64} />
        <Skeleton width="100%" height={64} />
        <Skeleton width="100%" height={64} />
      </div>
    );
  }

  const onLabel = t('profile.toggleOn');
  const offLabel = t('profile.toggleOff');

  return (
    <div className={styles.wrap}>
      {/* DEV-20 §5: тумблеры и селекты — строками на одной поверхности. */}
      <Surface>
      <SettingRow
        label={t('profile.privacyCardVisibility')}
        hint={t('profile.privacyCardVisibilityHint')}
        control="select"
        value={profile.profile_visibility}
        onSelectChange={(v) => updateProfile.mutate({ profile_visibility: v as ProfileVisibility })}
        options={[
          { value: 'public', label: t('profile.privacyCardVisibilityPublic') },
          { value: 'link_and_deals', label: t('profile.privacyCardVisibilityLinkAndDeals') },
        ]}
      />

      <SettingRow
        label={t('profile.privacyFindableByPhone')}
        hint={t('profile.privacyFindableByPhoneHint')}
        control="toggle"
        checked={consents.phone_discoverability === true}
        onToggle={(v) => recordConsent.mutate({ consent_type: 'phone_discoverability', value: v })}
        toggleOnLabel={onLabel}
        toggleOffLabel={offLabel}
      />

      <SettingRow
        label={t('profile.privacyHideFromCatalog')}
        hint={t('profile.privacyHideFromCatalogHint')}
        control="toggle"
        checked={profile.hide_from_catalog}
        onToggle={(v) => updateProfile.mutate({ hide_from_catalog: v })}
        toggleOnLabel={onLabel}
        toggleOffLabel={offLabel}
      />

      <SettingRow
        label={t('profile.privacyShowNameOnly')}
        hint={t('profile.privacyShowNameOnlyHint')}
        control="toggle"
        // show_name=true → имя показывается (дефолт); тумблер спрашивает обратное.
        checked={!profile.show_name}
        onToggle={(v) => updateProfile.mutate({ show_name: !v })}
        toggleOnLabel={onLabel}
        toggleOffLabel={offLabel}
      />

      <SettingRow
        label={t('profile.privacyAvatarVisibility')}
        hint={t('profile.privacyAvatarVisibilityHint')}
        control="select"
        value={profile.avatar_visibility}
        onSelectChange={(v) => updateProfile.mutate({ avatar_visibility: v as AvatarVisibility })}
        options={[
          { value: 'public', label: t('profile.privacyAvatarVisibilityPublic') },
          { value: 'deals_only', label: t('profile.privacyAvatarVisibilityDealsOnly') },
        ]}
      />
      </Surface>
    </div>
  );
}
