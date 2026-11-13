import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@porukam/core';
import { Badge, Button, Card, SettingRow, Skeleton, Surface, TextField } from '@porukam/ui';
import { useCurrentUser } from '../../features/auth/useAuth';
import { useUpdateProfile } from '../../features/profile/api';
import { useActorStore } from '../../features/actor/actorStore';
import styles from './AccountSettingsPage.module.css';

/** Строгая форма хранения — E.164 «через +» (отсмотр 2026-08-24): пробелы/
 * скобки/дефисы допустимы при вводе и срезаются при сохранении; та же
 * нормализация на бэке (apps.accounts.services.normalize_phone). */
const PHONE_RE = /^\+[1-9]\d{7,14}$/;

/** Настройки → аккаунт (DEV-02 §5): профили, телефон (находимость по номеру,
 * вариант А 2026-08-24), экспорт данных (заглушка), удаление аккаунта. */
export function AccountSettingsPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: me, isPending } = useCurrentUser();
  const update = useUpdateProfile();
  const [phone, setPhone] = useState('');
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [phoneSaved, setPhoneSaved] = useState(false);
  useEffect(() => {
    if (me && !phoneTouched) setPhone(me.phone ?? '');
  }, [me, phoneTouched]);

  async function savePhone(): Promise<void> {
    setPhoneError(null);
    setPhoneSaved(false);
    const normalized = phone.replace(/[\s\-()]/g, '');
    if (normalized && !PHONE_RE.test(normalized)) {
      setPhoneError(t('profile.phoneInvalid'));
      return;
    }
    try {
      await update.mutateAsync({ phone: normalized });
      setPhone(normalized);
      setPhoneSaved(true);
    } catch (e) {
      setPhoneError(e instanceof ApiError ? e.message : String(e));
    }
  }
  // Real-API `/users/me` не отдаёт `orgs` (поле из мок-контракта) — юрлица берём
  // из профилей actorStore, как ActorSwitcher; иначе `.map` по undefined роняет страницу.
  const orgs = useActorStore((s) => s.profiles).filter((p) => p.kind === 'business');

  if (isPending || !me) {
    return (
      <div className={styles.wrap}>
        <Skeleton width="100%" height={100} />
        <Skeleton width="100%" height={60} />
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <Card>
        <h3 className={styles.sectionTitle}>{t('profile.accProfilesTitle')}</h3>
        <div className={styles.profileRow}>
          <span>{me.display_name}</span>
          <Badge tone="teal">{t('profile.accActive')}</Badge>
        </div>
        {orgs.map((org) => (
          <div key={org.id} className={styles.profileRow}>
            <span>{org.display_name || org.handle || ''}</span>
          </div>
        ))}
        <Surface>
          <SettingRow label={t('profile.accOrgConfigure')} hint={t('profile.accOrgSoon')} control="link" disabled onLinkClick={() => {}} />
        </Surface>
      </Card>

      <Card>
        <h3 className={styles.sectionTitle}>{t('profile.phoneTitle')}</h3>
        <p className={styles.phoneHint}>{t('profile.phoneHint')}</p>
        <div className={styles.phoneRow}>
          <TextField
            label={t('profile.phoneLabel')}
            help={t('hints.settings.phone')}
            helpLabel={t('hints.helpButton')}
            placeholder="+7 999 123-45-67"
            inputMode="tel"
            value={phone}
            onChange={(e) => {
              setPhoneTouched(true);
              setPhoneSaved(false);
              setPhoneError(null);
              // Только «+», цифры и визуальные разделители — буквы не пропускаем.
              setPhone(e.target.value.replace(/[^\d+()\-\s]/g, ''));
            }}
            data-testid="phone-input"
          />
          <Button variant="primary" onClick={() => void savePhone()} loading={update.isPending} data-testid="phone-save">
            {t('profile.phoneSave')}
          </Button>
        </div>
        {phoneError ? (
          <p role="alert" className={styles.phoneError}>
            {phoneError}
          </p>
        ) : null}
        {phoneSaved ? <p className={styles.phoneSaved}>{t('profile.phoneSaved')}</p> : null}
      </Card>

      {/* DEV-20 §5: строки действий — на одной поверхности с hairline. */}
      <Surface>
        <SettingRow label={t('profile.accExportData')} hint={t('profile.accExportSoon')} control="link" disabled onLinkClick={() => {}} />
        <SettingRow
          label={t('profile.accDangerTitle')}
          control="link"
          danger
          onLinkClick={() => navigate('/me/settings/account/delete')}
        />
      </Surface>
    </div>
  );
}
