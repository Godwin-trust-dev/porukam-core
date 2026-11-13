import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@porukam/core';
import { Button, Logo, OtpField, TextField, Spark } from '@porukam/ui';
import { useRequestEmailCode, useVerifyEmailCode } from '../features/auth/useAuth';
import { useAuthStore } from '../features/auth/authStore';
import styles from './LoginPage.module.css';

/**
 * Вход/регистрация по e-mail шестизначным кодом (ADR-168, решение владельца
 * 06.09.2026): «вход только через Google» смягчён до «Google + почта».
 * Пароля НЕТ и magic-link НЕТ — только код из письма, тот же двухшаговый
 * контур, что у телефонного `LoginPage`, и ТОТ ЖЕ пост-логин путь
 * (`useVerifyEmailCode` → `setTokens` методом `'otp'` → `/users/me` → профили
 * актёра): гард `RequireGlobalOnboarding` спрашивает согласия GLOBAL только у
 * Google-сессий, локаль и остальное подхватывает оболочка.
 *
 * Стили — тот же модуль, что у телефонного входа (`LoginPage.module.css`):
 * два экрана входа обязаны выглядеть одинаково, а не разъезжаться при первой
 * же правке одного из них.
 *
 * Шаг адреса НИЧЕГО не сообщает о существовании аккаунта: бэк отвечает 200 на
 * любой синтаксически верный адрес, экран печатает нейтральное «если адрес
 * верный — письмо придёт».
 */
type Step = 'email' | 'code' | 'done';

/**
 * Пауза до повторной отправки письма, секунды (нет 429 — просто вежливость).
 *
 * Было 60 — ровно столько же, сколько обещал текст «письмо придёт в течение
 * минуты», и владелец 07.09 прочла этот отсчёт как СРОК ЖИЗНИ КОДА («времени
 * очень мало на приход кода, около минуты»). Теперь 30 с, а подпись кнопки
 * начинается с действия («Отправить ещё раз (через N с)»), чтобы отсчёт
 * нельзя было принять за таймер годности.
 */
const RESEND_COOLDOWN_SEC = 30;

/**
 * Сколько живёт код из письма — для подписи под полем ввода.
 * Должно совпадать с дефолтом бэка `EMAIL_OTP_CODE_TTL_SECONDS` (900 с,
 * apps.accounts.services); экран этого числа не знает и не запрашивает —
 * ответ `/auth/email/request` пустой по соображениям приватности.
 */
const EMAIL_CODE_TTL_MIN = 15;

/** Грубый разбор адреса на клиенте — до сети, чтобы не тратить лимит на опечатку. */
const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

export function EmailLoginPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  // Куда вернуть после входа: `RequireAuth` кладёт исходный путь в `state.from`.
  const from = (location.state as { from?: string } | null)?.from;
  const target = from && from.startsWith('/') && !from.startsWith('//') ? from : '/';

  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [consent, setConsent] = useState(false);
  const [devHint, setDevHint] = useState<string | null>(null);
  // Адрес, на который письмо уже ушло: пауза до повтора держится ТОЛЬКО для
  // него. Иначе «Изменить адрес» после опечатки упирался бы в чужой отсчёт —
  // а именно опечатка и есть главная причина туда нажимать.
  const [sentTo, setSentTo] = useState('');
  const [emailError, setEmailError] = useState<string | undefined>();
  const [codeError, setCodeError] = useState<string | undefined>();
  const [cooldown, setCooldown] = useState(0);
  // Канал выключен на бэке (403 email_login_disabled) — тупик, из которого
  // ведёт ровно одна дверь: Google. Отдельное состояние, а не текст ошибки
  // под полем: повторять запрос бессмысленно.
  const [disabled, setDisabled] = useState(false);

  const requestCode = useRequestEmailCode();
  const verifyCode = useVerifyEmailCode();
  const timerRef = useRef<number | null>(null);

  /** Пауза действует, только пока в поле тот же адрес, на который ушло письмо. */
  const throttled = cooldown > 0 && email.trim().toLowerCase() === sentTo;

  // Уже авторизованного уводим в приложение — только на шаге адреса, иначе
  // гонка со «искрой» успешного входа (та же оговорка, что в LoginPage).
  useEffect(() => {
    if (isAuthenticated && step === 'email') navigate(target, { replace: true });
  }, [isAuthenticated, step, navigate, target]);

  useEffect(() => {
    if (step !== 'done') return;
    const id = window.setTimeout(() => navigate(target, { replace: true }), 900);
    return () => window.clearTimeout(id);
  }, [step, navigate, target]);

  // Обратный отсчёт паузы (бэкофф по 429 или вежливая пауза после отправки).
  useEffect(() => {
    if (cooldown <= 0) return;
    timerRef.current = window.setInterval(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [cooldown]);

  /** 403 email_login_disabled — общий разбор для обоих шагов. */
  function isDisabledError(e: unknown): boolean {
    return e instanceof ApiError && e.code === 'email_login_disabled';
  }

  /** 429 — «слишком часто»: секунды берём из problem.retry_after, дефолт 30. */
  function rateLimitSeconds(e: unknown): number | null {
    if (!(e instanceof ApiError)) return null;
    if (e.status !== 429 && e.code !== 'otp_rate_limited' && e.code !== 'rate_limited') return null;
    return e.problem.retry_after ?? 30;
  }

  async function onSendCode(): Promise<void> {
    setEmailError(undefined);
    if (!looksLikeEmail(email.trim())) {
      setEmailError(t('auth.errorInvalidEmail'));
      return;
    }
    try {
      const res = await requestCode.mutateAsync(email.trim());
      // Реальный бэк отвечает 200 БЕЗ тела — `res` здесь undefined; `dev_hint`
      // есть только на стенде с фиксированным кодом (как у телефонного входа).
      setDevHint(res?.dev_hint ?? null);
      setSentTo(email.trim().toLowerCase());
      setCooldown(RESEND_COOLDOWN_SEC);
      setStep('code');
    } catch (e) {
      if (isDisabledError(e)) {
        setDisabled(true);
        return;
      }
      const sec = rateLimitSeconds(e);
      if (sec !== null) {
        setSentTo(email.trim().toLowerCase());
        setCooldown(sec);
        setEmailError(t('auth.errorTooMany', { sec }));
        return;
      }
      setEmailError(t('auth.errorInvalidEmail'));
    }
  }

  async function onVerify(): Promise<void> {
    setCodeError(undefined);
    try {
      await verifyCode.mutateAsync({ email: email.trim(), code });
      // Искра — событие доверия (§5.1). Переход выполняет useEffect по step==='done'.
      setStep('done');
    } catch (e) {
      if (isDisabledError(e)) {
        setDisabled(true);
        return;
      }
      const sec = rateLimitSeconds(e);
      if (sec !== null) {
        setCooldown(sec);
        setCodeError(t('auth.errorTooMany', { sec }));
        return;
      }
      if (e instanceof ApiError && e.code === 'otp_code_expired') {
        setCodeError(t('auth.errorCodeExpired'));
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
        {/* Знак на якорном экране (DEV-17 §3): вспышка — в самом знаке. */}
        <Logo variant="mark" size={72} className={styles.heroMark} />
        <h1 className={styles.heroTitle}>{t('auth.heroTitle')}</h1>
        <p className={styles.heroText}>{t('auth.heroText')}</p>
      </aside>

      <main className={styles.panel}>
        <div className={styles.card}>
          {disabled && (
            <div data-testid="email-login-disabled">
              <h2 className={styles.title}>{t('auth.emailDisabledTitle')}</h2>
              <p className={styles.subtitle}>{t('auth.emailDisabledText')}</p>
            </div>
          )}
          {disabled && (
            <Button variant="primary" block onClick={() => navigate('/welcome', { replace: true })}>
              {t('auth.emailDisabledAction')}
            </Button>
          )}

          {!disabled && step === 'email' && (
            <>
              <h2 className={styles.title}>{t('auth.emailTitle')}</h2>
              <p className={styles.subtitle}>{t('auth.emailSubtitle')}</p>
              <TextField
                label={t('auth.emailLabel')}
                placeholder={t('auth.emailPlaceholder')}
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                error={emailError}
                onChange={(e) => setEmail(e.target.value)}
              />
              <label className={styles.consent}>
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                <span>{t('auth.legalConsent')}</span>
              </label>
              <Button
                variant="primary"
                block
                onClick={onSendCode}
                loading={requestCode.isPending}
                disabled={!consent || throttled}
              >
                {throttled ? t('auth.resendIn', { sec: cooldown }) : t('auth.sendCode')}
              </Button>
            </>
          )}

          {!disabled && step === 'code' && (
            <>
              <h2 className={styles.title}>{t('auth.emailCodeTitle')}</h2>
              <p className={styles.subtitle}>{t('auth.emailCodeSubtitle', { email: email.trim() })}</p>
              {/* Нейтральная формулировка: существование аккаунта не раскрываем. */}
              <p className={styles.subtitle}>{t('auth.emailSentNotice')}</p>
              {devHint ? <div className={styles.devHint}>{t('auth.devHint', { code: devHint })}</div> : null}
              <OtpField
                label={t('auth.codeLabel')}
                value={code}
                error={codeError}
                autoFocus
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
              {/* Срок кода — ПОД полем: раньше единственным числом на экране
                  был отсчёт повторной отправки, и он читался как «код живёт
                  минуту» (замечание владельца 07.09). */}
              <p className={styles.hint} data-testid="email-code-validity">
                {t('auth.emailCodeValidity', { minutes: EMAIL_CODE_TTL_MIN })}
              </p>
              <Button
                variant="primary"
                block
                onClick={onVerify}
                loading={verifyCode.isPending}
                disabled={code.length < 6}
              >
                {t('auth.verify')}
              </Button>
              <div className={styles.linkRow}>
                <button
                  type="button"
                  className={styles.linkBtn}
                  onClick={() => {
                    setStep('email');
                    setCode('');
                    setCodeError(undefined);
                  }}
                >
                  {t('auth.changeEmail')}
                </button>
                <button
                  type="button"
                  className={styles.linkBtn}
                  onClick={onSendCode}
                  disabled={throttled || requestCode.isPending}
                >
                  {throttled ? t('auth.resendIn', { sec: cooldown }) : t('auth.resend')}
                </button>
              </div>
            </>
          )}

          {!disabled && step === 'done' && (
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
