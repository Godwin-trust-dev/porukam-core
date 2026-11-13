import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError, mapErrorToAction } from '@porukam/core';
import { Button, Logo, OtpField, TextField, Spark } from '@porukam/ui';
import { useRequestOtp, useVerifyOtp } from '../features/auth/useAuth';
import { useAuthStore } from '../features/auth/authStore';
import styles from './LoginPage.module.css';

type Step = 'phone' | 'code' | 'done';

export function LoginPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  // Куда вернуть после входа: `RequireAuth` кладёт исходный путь в `state.from`,
  // чтобы человек попадал на ту страницу, с которой его увело, а не на главную.
  const from = (location.state as { from?: string } | null)?.from;
  const target = from && from.startsWith('/') && !from.startsWith('//') ? from : '/';

  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [consent, setConsent] = useState(false);
  const [devHint, setDevHint] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | undefined>();
  const [codeError, setCodeError] = useState<string | undefined>();
  const [backoff, setBackoff] = useState(0);

  const requestOtp = useRequestOtp();
  const verifyOtp = useVerifyOtp();
  const timerRef = useRef<number | null>(null);

  // Уже авторизованного пользователя, попавшего на экран входа, уводим в приложение.
  // Только на шаге телефона — иначе гонка: setTokens поднимает isAuthenticated
  // раньше, чем step станет 'done', и мы проскочили бы искру успешного входа.
  useEffect(() => {
    if (isAuthenticated && step === 'phone') navigate(target, { replace: true });
  }, [isAuthenticated, step, navigate, target]);

  // Успешный вход: показать искру ~0.9с, затем перейти. Таймер очищается при
  // размонтировании — иначе он мог бы «дёрнуть» навигацию уже на другом экране.
  useEffect(() => {
    if (step !== 'done') return;
    const id = window.setTimeout(() => navigate(target, { replace: true }), 900);
    return () => window.clearTimeout(id);
  }, [step, navigate, target]);

  // Обратный отсчёт бэкоффа при 429 (ТЗ §9.8, §10.6).
  useEffect(() => {
    if (backoff <= 0) return;
    timerRef.current = window.setInterval(() => setBackoff((s) => Math.max(0, s - 1)), 1000);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [backoff]);

  async function onSendCode(): Promise<void> {
    setPhoneError(undefined);
    if (phone.replace(/\D/g, '').length < 10) {
      setPhoneError(t('auth.phoneLabel'));
      return;
    }
    try {
      const res = await requestOtp.mutateAsync(phone);
      // Реальный /auth/otp/request отвечает 200 БЕЗ тела (dev_hint — только у
      // мока): res здесь undefined, и `res.dev_hint` ронял вход в «Неверный
      // код» ещё на шаге телефона (§E-смоук 2026-08-18).
      setDevHint(res?.dev_hint ?? null);
      setStep('code');
    } catch (e) {
      if (e instanceof ApiError) {
        const action = mapErrorToAction(e);
        if (action.kind === 'backoff') {
          setBackoff(action.retryAfter ?? 30);
          setPhoneError(t('auth.errorTooMany', { sec: action.retryAfter ?? 30 }));
          return;
        }
      }
      setPhoneError(t('auth.errorInvalidCode'));
    }
  }

  async function onVerify(): Promise<void> {
    setCodeError(undefined);
    try {
      await verifyOtp.mutateAsync({ phone, code });
      // Искра — событие доверия (§5.1). Переход выполняет useEffect по step==='done'.
      setStep('done');
    } catch (e) {
      if (e instanceof ApiError && e.is('rate_limited')) {
        setBackoff(e.problem.retry_after ?? 30);
        setCodeError(t('auth.errorTooMany', { sec: e.problem.retry_after ?? 30 }));
        return;
      }
      setCodeError(t('auth.errorInvalidCode'));
    }
  }

  return (
    <div className={styles.screen} data-density="cozy">
      <aside className={styles.hero}>
        <div className={styles.heroGlow} />
        <span className="pr-eyebrow" style={{ color: 'var(--pr-amber-hi)' }}>
          {t('common.appName')}
        </span>
        {/* Знак на якорном экране (DEV-17 §3: вход/hero — место знака).
            Вспышка — в самом знаке, отдельная искра рядом не запускается. */}
        <Logo variant="mark" size={72} className={styles.heroMark} />
        <h1 className={styles.heroTitle}>{t('auth.heroTitle')}</h1>
        <p className={styles.heroText}>{t('auth.heroText')}</p>
      </aside>

      <main className={styles.panel}>
        <div className={styles.card}>
          {step === 'phone' && (
            <>
              <h2 className={styles.title}>{t('auth.title')}</h2>
              <p className={styles.subtitle}>{t('auth.subtitle')}</p>
              <TextField
                label={t('auth.phoneLabel')}
                placeholder={t('auth.phonePlaceholder')}
                inputMode="tel"
                autoComplete="tel"
                value={phone}
                error={phoneError}
                onChange={(e) => setPhone(e.target.value)}
              />
              <label className={styles.consent}>
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                <span>{t('auth.legalConsent')}</span>
              </label>
              <Button
                variant="primary"
                block
                onClick={onSendCode}
                loading={requestOtp.isPending}
                disabled={!consent || backoff > 0}
              >
                {backoff > 0 ? t('auth.resendIn', { sec: backoff }) : t('auth.sendCode')}
              </Button>
            </>
          )}

          {step === 'code' && (
            <>
              <h2 className={styles.title}>{t('auth.codeTitle')}</h2>
              <p className={styles.subtitle}>{t('auth.codeSubtitle', { phone })}</p>
              {devHint ? <div className={styles.devHint}>{t('auth.devHint', { code: devHint })}</div> : null}
              <OtpField
                label={t('auth.codeLabel')}
                value={code}
                error={codeError}
                autoFocus
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
              <Button
                variant="primary"
                block
                onClick={onVerify}
                loading={verifyOtp.isPending}
                disabled={code.length < 6}
              >
                {t('auth.verify')}
              </Button>
              <div className={styles.linkRow}>
                <button type="button" className={styles.linkBtn} onClick={() => setStep('phone')}>
                  {t('auth.changePhone')}
                </button>
                <button
                  type="button"
                  className={styles.linkBtn}
                  onClick={onSendCode}
                  disabled={backoff > 0 || requestOtp.isPending}
                >
                  {backoff > 0 ? t('auth.resendIn', { sec: backoff }) : t('auth.resend')}
                </button>
              </div>
            </>
          )}

          {step === 'done' && (
            <div className={styles.success} data-testid="login-success">
              <Spark size={104} title={t('common.appName')} />
              <h2 className={styles.title}>{t('auth.welcome')}</h2>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
