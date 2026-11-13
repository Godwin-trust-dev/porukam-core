import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useInstall } from '../src/features/pwa/useInstall';
import { usePwaStore } from '../src/features/pwa/pwaStore';

function dispatchBeforeInstallPrompt(promptSpy?: () => void) {
  const evt = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
    prompt?: () => Promise<void>;
    userChoice?: Promise<{ outcome: string; platform: string }>;
  };
  evt.prompt = () => {
    promptSpy?.();
    return Promise.resolve();
  };
  evt.userChoice = Promise.resolve({ outcome: 'accepted', platform: '' });
  window.dispatchEvent(evt);
}

describe('useInstall (DEV-15 §2) — критерии приёмки §10.2', () => {
  beforeEach(() => {
    localStorage.clear();
    // Перехваченный промпт живёт в сторе (`installPromptCapture`, до первого рендера) —
    // без сброса он переходил бы из теста в тест.
    usePwaStore.setState({ installPrompt: null });
  });
  afterEach(() => localStorage.clear());

  it('beforeinstallprompt → canInstall становится true, promptInstall() зовёт event.prompt()', async () => {
    const { result } = renderHook(() => useInstall());
    expect(result.current.canInstall).toBe(false);

    let called = false;
    act(() => dispatchBeforeInstallPrompt(() => (called = true)));
    expect(result.current.canInstall).toBe(true);

    await act(async () => {
      await result.current.promptInstall();
    });
    expect(called).toBe(true);
    // после промпта — deferredPrompt одноразовый
    expect(result.current.canInstall).toBe(false);
  });

  it('appinstalled → canInstall=false, isStandalone=true, dismissed=true (баннер прячется насовсем)', () => {
    const { result } = renderHook(() => useInstall());
    act(() => dispatchBeforeInstallPrompt());
    expect(result.current.canInstall).toBe(true);

    act(() => window.dispatchEvent(new Event('appinstalled')));
    expect(result.current.canInstall).toBe(false);
    expect(result.current.isStandalone).toBe(true);
    expect(result.current.dismissed).toBe(true);
  });

  it('appinstalled — переживает свежий монтаж хука на другой странице (matchMedia в этой вкладке не флипнется)', () => {
    const { result, unmount } = renderHook(() => useInstall());
    act(() => window.dispatchEvent(new Event('appinstalled')));
    expect(result.current.isStandalone).toBe(true);
    unmount();

    const { result: result2 } = renderHook(() => useInstall());
    expect(result2.current.isStandalone).toBe(true);
  });

  it('нет промпта и не iOS — needsManualHowTo: показать инструкцию по меню браузера', () => {
    const { result } = renderHook(() => useInstall());
    expect(result.current.canInstall).toBe(false);
    expect(result.current.needsManualHowTo).toBe(true);

    // Промпт пришёл — ручная инструкция больше не нужна.
    act(() => dispatchBeforeInstallPrompt());
    expect(result.current.needsManualHowTo).toBe(false);
  });

  it('через неделю после «✕» предложение возвращается (05.09 — крестик откладывает, не отменяет)', () => {
    localStorage.setItem('porukam.installBannerDismissedAt', String(Date.now() - 8 * 24 * 60 * 60 * 1000));
    const { result } = renderHook(() => useInstall());
    expect(result.current.dismissed).toBe(false);
  });

  it('dismiss() — запоминает выбор в localStorage, переживает новый рендер хука', () => {
    const { result, unmount } = renderHook(() => useInstall());
    act(() => result.current.dismiss());
    expect(result.current.dismissed).toBe(true);
    unmount();

    const { result: result2 } = renderHook(() => useInstall());
    expect(result2.current.dismissed).toBe(true);
  });

  it('standalone (matchMedia display-mode) — canInstall всегда false, даже после beforeinstallprompt', () => {
    // jsdom не реализует matchMedia — своя заглушка (не .bind() несуществующего оригинала).
    const original = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({
        matches: query.includes('display-mode: standalone'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
        onchange: null,
      }) as MediaQueryList) as typeof window.matchMedia;

    const { result } = renderHook(() => useInstall());
    expect(result.current.isStandalone).toBe(true);
    act(() => dispatchBeforeInstallPrompt());
    expect(result.current.canInstall).toBe(false);

    window.matchMedia = original;
  });
});
