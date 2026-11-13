import { useCallback, useEffect, useState } from 'react';
import { isAppWrapper } from './appWrapper';
import { dismissInstall, isInstallDismissed, isMarkedInstalled, markInstalled } from './installDismissed';
import { captureInstallPrompt } from './installPromptCapture';
import { usePwaStore } from './pwaStore';

export interface UseInstallResult {
  /** Android/Chromium/desktop — `beforeinstallprompt` пойман, можно звать системный промпт. */
  canInstall: boolean;
  /** iOS Safari — нет `beforeinstallprompt`, установка только через инструкцию (§ло-фай 3). */
  isIos: boolean;
  /** Уже установлено (окно приложения, обёртка из Play или прошлый `appinstalled`) — точки скрыты. */
  isStandalone: boolean;
  /** Мы внутри установленного приложения (TWA/standalone) — для подсказок, зависящих от обёртки. */
  isAppWrapper: boolean;
  /** Баннер отложен «✕» — не показывать до конца недели (`INSTALL_BANNER_SNOOZE_MS`). */
  dismissed: boolean;
  /**
   * Системного промпта нет и iOS-инструкция не подходит (Android без `beforeinstallprompt`,
   * десктопный Firefox, Samsung Internet) — установка возможна только руками через меню
   * браузера, показываем `InstallHowToSheet`. Раньше в этом случае кнопка молчала.
   */
  needsManualHowTo: boolean;
  promptInstall: () => Promise<void>;
  dismiss: () => void;
}

function detectIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const isAppleTouch = /iphone|ipad|ipod/i.test(ua);
  // iPadOS 13+ представляется как Macintosh, но имеет тачскрин — отличаем от десктопного Mac.
  const isIpadOs13 = ua.includes('Macintosh') && navigator.maxTouchPoints > 1;
  return isAppleTouch || isIpadOs13;
}

function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  // `isMarkedInstalled()` — персистентный флаг из прошлого `appinstalled` (см. installDismissed.ts):
  // matchMedia в ЭТОЙ вкладке-браузере не станет standalone (установленное приложение — отдельное
  // окно), но остальные страницы SPA всё равно должны считать установку свершившейся.
  //
  // `isAppWrapper()` — признак обёртки из Play (`android-app://` в реферере, `?src=twa`), а не
  // только медиазапрос: 10.09 владелец увидела предложение «скачать приложение» ВНУТРИ
  // скачанного приложения — часть сборок TWA отдаёт `display-mode: browser`.
  return isAppWrapper() || isMarkedInstalled();
}

/**
 * Установка на экран (DEV-15 §2): системный промпт (`beforeinstallprompt` ловится рано, в
 * `installPromptCapture.ts` — см. там почему не здесь), детект iOS (нет системного промпта —
 * только инструкция) и `standalone` (уже установлено — все install-точки скрыты).
 * `appinstalled` прячет баннер насовсем.
 */
export function useInstall(): UseInstallResult {
  const deferredPrompt = usePwaStore((s) => s.installPrompt);
  const [isStandalone, setIsStandalone] = useState(detectStandalone);
  const [wrapper] = useState(isAppWrapper);
  const [dismissed, setDismissed] = useState(isInstallDismissed);
  const [isIos] = useState(detectIos);

  useEffect(() => {
    // Подстраховка: в обычном приложении перехват уже включён из `main.tsx`, но в тестах,
    // Storybook и любой другой точке входа хук обязан работать сам по себе. Функция
    // идемпотентна — второй слушатель не появится.
    captureInstallPrompt();

    function onAppInstalled(): void {
      setIsStandalone(true);
      markInstalled();
      dismissInstall();
      setDismissed(true);
    }
    const media = window.matchMedia?.('(display-mode: standalone)');
    function onDisplayModeChange(e: MediaQueryListEvent): void {
      if (e.matches) setIsStandalone(true);
    }

    window.addEventListener('appinstalled', onAppInstalled);
    media?.addEventListener?.('change', onDisplayModeChange);
    return () => {
      window.removeEventListener('appinstalled', onAppInstalled);
      media?.removeEventListener?.('change', onDisplayModeChange);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    const evt = usePwaStore.getState().installPrompt;
    if (!evt) return;
    await evt.prompt();
    await evt.userChoice;
    // Промпт одноразовый: повторно тот же объект браузер вызвать не даст.
    usePwaStore.getState().setInstallPrompt(null);
  }, []);

  const dismiss = useCallback(() => {
    dismissInstall();
    setDismissed(true);
  }, []);

  const canInstall = Boolean(deferredPrompt) && !isStandalone;
  return {
    canInstall,
    isIos: isIos && !isStandalone,
    isStandalone,
    isAppWrapper: wrapper,
    dismissed,
    needsManualHowTo: !canInstall && !isIos && !isStandalone,
    promptInstall,
    dismiss,
  };
}
