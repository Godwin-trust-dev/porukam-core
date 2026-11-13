import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '@porukam/i18n';
import { captureAppWrapper, isAppWrapper } from '../src/features/pwa/appWrapper';
import { useInstall } from '../src/features/pwa/useInstall';
import { PwaSurfaces } from '../src/features/pwa/PwaSurfaces';
import { usePwaStore } from '../src/features/pwa/pwaStore';

/**
 * «Сайт не видит установленное приложение» (владелец 10.09: *«я скачала
 * приложение, но его не сразу сайт увидел, он сначала предлагал мне скачать
 * приложение»*). Внутри обёртки предложение установки не показывается нигде —
 * и признак обёртки не сводится к `display-mode: standalone`.
 */
function setReferrer(value: string): void {
  Object.defineProperty(document, 'referrer', { configurable: true, value });
}

function setHref(search: string): void {
  window.history.replaceState({}, '', `/${search}`);
}

function Harness(): JSX.Element {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate('/contracts')}>go</button>
      <PwaSurfaces />
    </>
  );
}

function renderSurfaces() {
  const i18n = createI18n('ru');
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={['/']}>
        <Harness />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

function dispatchBeforeInstallPrompt(): void {
  const evt = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
    prompt?: () => Promise<void>;
    userChoice?: Promise<{ outcome: string; platform: string }>;
  };
  evt.prompt = () => Promise.resolve();
  evt.userChoice = Promise.resolve({ outcome: 'accepted', platform: '' });
  window.dispatchEvent(evt);
}

describe('признак обёртки (10.09: предложение установки внутри приложения)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    setReferrer('');
    setHref('');
    usePwaStore.setState({ installPrompt: null });
  });
  afterEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    setReferrer('');
    setHref('');
  });

  it('обычная вкладка — признака нет', () => {
    expect(isAppWrapper()).toBe(false);
  });

  it('реферер `android-app://` — обёртка из Play', () => {
    setReferrer('android-app://porukam.app');
    expect(isAppWrapper()).toBe(true);
  });

  it('`?src=twa` в стартовом адресе — обёртка, признак переживает уход параметра', () => {
    setHref('?src=twa');
    expect(captureAppWrapper()).toBe(true);
    // Параметр вычищается первым же переходом по маршруту — ответ берётся из сессии.
    setHref('');
    expect(isAppWrapper()).toBe(true);
  });

  it('`display-mode: standalone` — тоже установленное приложение, но в сессии не запоминается', () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({
        matches: query.includes('standalone'),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    try {
      expect(isAppWrapper()).toBe(true);
      // Режим окна читается заново каждый раз: он может смениться на ходу.
      expect(sessionStorage.getItem('porukam.appWrapper')).toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });

  it('useInstall в обёртке: isStandalone/isAppWrapper — да, canInstall — нет', () => {
    setReferrer('android-app://porukam.app');
    const { result } = renderHook(() => useInstall());
    expect(result.current.isAppWrapper).toBe(true);
    expect(result.current.isStandalone).toBe(true);
    expect(result.current.canInstall).toBe(false);
    // И «поставьте руками через меню браузера» тоже не предлагаем — уже стоит.
    expect(result.current.needsManualHowTo).toBe(false);
    expect(result.current.isIos).toBe(false);
  });

  it('в обёртке install-баннер не появляется даже после перехода по маршруту', async () => {
    setReferrer('android-app://porukam.app');
    renderSurfaces();
    dispatchBeforeInstallPrompt();
    await userEvent.click(screen.getByText('go'));
    await waitFor(() => expect(screen.getByText('go')).toBeInTheDocument());
    expect(screen.queryByText(/Установите Porukam/)).not.toBeInTheDocument();
  });

  it('без обёртки тот же сценарий баннер показывает (контроль)', async () => {
    renderSurfaces();
    dispatchBeforeInstallPrompt();
    await userEvent.click(screen.getByText('go'));
    await waitFor(() => expect(screen.getByText(/Установите Porukam/)).toBeInTheDocument());
  });
});
