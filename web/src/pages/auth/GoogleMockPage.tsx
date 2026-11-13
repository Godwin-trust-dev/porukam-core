import { useSearchParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@porukam/ui';
import { useForceLocale } from '../../features/onboarding/useForceLocale';
import styles from './GoogleMockPage.module.css';

interface Persona {
  sub: string;
  email: string;
  titleKey: string;
  textKey: string;
}

const PERSONAS: Persona[] = [
  { sub: 'sub-cold-1', email: 'newcomer@example.com', titleKey: 'auth.mockColdTitle', textKey: 'auth.mockColdText' },
  { sub: 'sub-invite-1', email: 'invited@example.com', titleKey: 'auth.mockInviteTitle', textKey: 'auth.mockInviteText' },
  { sub: 'sub-existing-1', email: 'dana.existing@example.com', titleKey: 'auth.mockExistingTitle', textKey: 'auth.mockExistingText' },
];

/**
 * ЗАГЛУШКА реального Google-консента (нет доступа к реальному OAuth в
 * Ф1-Ф5, web/CLAUDE.md §3) — детерминированный выбор персоны, тот же приём,
 * что `FakeGoogleOAuthProvider` на бэке (код авторизации кодирует `sub|email`,
 * ADR-071). ТОЛЬКО dev/демо — в проде подменяется реальным accounts.google.com.
 */
export function GoogleMockPage(): JSX.Element {
  useForceLocale('en');
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const state = searchParams.get('state') ?? '';

  function allow(persona: Persona): void {
    const code = `${persona.sub}|${persona.email}`;
    navigate(`/auth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
  }

  function deny(): void {
    navigate(`/auth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`);
  }

  return (
    <div className={styles.screen}>
      <div className={styles.card} data-testid="google-mock">
        <h1 className={styles.title}>{t('auth.mockTitle')}</h1>
        <p className={styles.subtitle}>{t('auth.mockSubtitle')}</p>
        <div className={styles.personas}>
          {PERSONAS.map((p) => (
            <button key={p.sub} type="button" className={styles.persona} data-testid={`google-mock-${p.sub}`} onClick={() => allow(p)}>
              <span className={styles.personaTitle}>{t(p.titleKey)}</span>
              <span className={styles.personaText}>{t(p.textKey)}</span>
            </button>
          ))}
        </div>
        <Button variant="ghost" className={styles.deny} onClick={deny} data-testid="google-mock-deny">
          {t('auth.mockDeny')}
        </Button>
      </div>
    </div>
  );
}
