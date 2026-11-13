import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ProfileVisibility } from '@porukam/core';
import { LanguageSwitcher, SectionLabel, SettingRow, Surface, type IconName } from '@porukam/ui';
import { useActorStore } from '../../features/actor/actorStore';
import { useCurrentUser } from '../../features/auth/useAuth';
import { useLogout } from '../../features/auth/useLogout';
import { useLanguageSwitcherProps } from '../../features/locale/useLanguageSwitcherProps';
import {
  findOwnPersonProfileId,
  useMyConsents,
  useOwnProfileSettings,
  useRecordConsent,
  useUpdateOwnProfileSettings,
} from '../../features/profile/api';
import { SETTINGS_SECTION_KEYS, GROUP_SECTION } from './sections';
import styles from './SettingsHubPage.module.css';

/** Значки разделов (финал доска A: строки настроек — со значком слева). */
const SECTION_ICON: Record<string, IconName> = {
  group: 'share',
  profile: 'profile',
  privacy: 'shield',
  notifications: 'bell',
  app: 'install',
  account: 'settings',
  security: 'shield',
};

/**
 * Хаб настроек на узком экране (замечание владельца 01.09, финал доска A
 * 03.09) — две группы строк на поверхностях во всю ширину:
 *
 * «ВИДИМОСТЬ» — три тумблера прямо здесь (находимость в поиске, публичная
 * репутация, находимость по телефону): это те же поля, что в разделе
 * «Приватность» (`PrivacySettingsPage`, ADR-059/087), и пишутся теми же
 * мутациями — хаб лишь показывает самые частые из них без лишнего перехода.
 * «АККАУНТ» — «Язык» первым и со значением, затем разделы настроек.
 *
 * Плашки «видимость не покупается» (ADR-059) здесь БОЛЬШЕ НЕТ — решение
 * владельца 05.09 («скрой его во всех локалях»): сам принцип остаётся в
 * ADR-059 и в юридических текстах, но на экране настроек он объяснял то,
 * чего человек и не пытался сделать. Ключ `profile.hubVisibilityNote` снят
 * из 29 локалей тем же решением.
 *
 * Что здесь чинится с 01.09. Раньше разделы жили полосой «пилюль» с
 * `overflow-x: auto` поверх экрана: пять названий по 7–11 символов на 360px
 * не помещались, и «Приложение» уезжало за правый край. Строки такого класса
 * ошибок не допускают в принципе (DEV-20_2 §3).
 *
 * Только мобильный: на десктопе разделы всегда видны липким рейлом слева
 * (`SettingsNav`), и хаб был бы лишним экраном на ровном месте — там
 * `/me/settings` по-прежнему сразу открывает первый раздел.
 */
export function SettingsHubPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const activeGroupId = useActorStore((s) => s.activeGroupId);
  const languageSwitcherProps = useLanguageSwitcherProps();
  const logout = useLogout();

  const { data: me } = useCurrentUser();
  const profileId = findOwnPersonProfileId(me?.profiles);
  const { data: profile } = useOwnProfileSettings(profileId);
  const { data: consents } = useMyConsents();
  const updateProfile = useUpdateOwnProfileSettings(profileId);
  const recordConsent = useRecordConsent();

  const keys = activeGroupId ? [GROUP_SECTION, ...SETTINGS_SECTION_KEYS] : [...SETTINGS_SECTION_KEYS];
  const onLabel = t('profile.toggleOn');
  const offLabel = t('profile.toggleOff');

  return (
    <div className={styles.page}>
      {profile && consents ? (
        <section aria-label={t('profile.hubVisibilityTitle')}>
          <SectionLabel>{t('profile.hubVisibilityTitle')}</SectionLabel>
          <Surface bleed data-testid="settings-hub-visibility">
            <SettingRow
              icon="search"
              label={t('profile.hubFindable')}
              hint={t('profile.hubFindableHint')}
              control="toggle"
              checked={!profile.hide_from_catalog}
              onToggle={(v) => updateProfile.mutate({ hide_from_catalog: !v })}
              toggleOnLabel={onLabel}
              toggleOffLabel={offLabel}
              data-testid="settings-hub-findable"
            />
            <SettingRow
              icon="reputation"
              label={t('profile.hubPublicReputation')}
              hint={t('profile.hubPublicReputationHint')}
              control="toggle"
              checked={profile.profile_visibility === 'public'}
              onToggle={(v) => updateProfile.mutate({ profile_visibility: (v ? 'public' : 'link_and_deals') as ProfileVisibility })}
              toggleOnLabel={onLabel}
              toggleOffLabel={offLabel}
              data-testid="settings-hub-public"
            />
            <SettingRow
              icon="profile"
              label={t('profile.privacyFindableByPhone')}
              hint={t('profile.privacyFindableByPhoneHint')}
              control="toggle"
              checked={consents.phone_discoverability === true}
              onToggle={(v) => recordConsent.mutate({ consent_type: 'phone_discoverability', value: v })}
              toggleOnLabel={onLabel}
              toggleOffLabel={offLabel}
              data-testid="settings-hub-phone"
            />
          </Surface>
        </section>
      ) : null}

      <section aria-label={t('profile.hubAccountTitle')}>
        <SectionLabel>{t('profile.hubAccountTitle')}</SectionLabel>
        <Surface bleed data-testid="settings-hub">
          {/* Язык — первым и со значением: именно его искали на этом экране. */}
          <LanguageSwitcher variant="row" rowIcon="globe" {...languageSwitcherProps} />
          {keys.map((key) => (
            <SettingRow
              key={key}
              icon={SECTION_ICON[key] ?? 'settings'}
              label={t(`profile.nav${key.charAt(0).toUpperCase()}${key.slice(1)}`)}
              control="link"
              onLinkClick={() => navigate(`/me/settings/${key}`)}
              data-testid={`settings-hub-${key}`}
            />
          ))}
        </Surface>
      </section>

      {/* «Выйти» — последней строкой (замечание владельца 07.09): раздел
          «Безопасность», где выход жил раньше, скрыт из списка с 21.08, и
          сменить аккаунт было негде. Не `danger`: аккаунт цел, кончается
          только сессия. Второй вход в это же действие — меню актёра в шапке. */}
      <Surface bleed>
        <SettingRow
          icon="logout"
          label={t('shell.logout')}
          control="link"
          onLinkClick={logout}
          data-testid="settings-logout"
        />
      </Surface>
    </div>
  );
}
