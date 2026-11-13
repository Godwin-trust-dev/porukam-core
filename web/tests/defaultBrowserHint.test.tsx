import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '@porukam/i18n';
import { DefaultBrowserHint } from '../src/features/pwa/DefaultBrowserHint';
import {
  DEFAULT_APPS_INTENT,
  isNonChromeWrapper,
  openDefaultAppsSettings,
  shouldShowDefaultBrowserHint,
} from '../src/features/pwa/defaultBrowserHint';

/**
 * «Единственное, что работает — установка браузера по умолчанию Chrome; мы
 * должны предлагать людям и давать ссылку на смену браузера» (владелец 10.09).
 *
 * Плашка выходит ТОЛЬКО внутри приложения и только не в Chrome: в обычной
 * вкладке советовать человеку менять браузер телефона не за что.
 */
const CHROME_UA =
  'Mozilla/5.0 (Linux; Android 14; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';
// У Samsung Internet в строке ТОЖЕ есть `Chrome/` — он на Chromium.
const SAMSUNG_UA =
  'Mozilla/5.0 (Linux; Android 14; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36';
const FIREFOX_UA = 'Mozilla/5.0 (Android 14; Mobile; rv:129.0) Gecko/129.0 Firefox/129.0';

function setUa(ua: string): void {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: ua });
}

function setWrapper(on: boolean): void {
  Object.defineProperty(document, 'referrer', {
    configurable: true,
    value: on ? 'android-app://porukam.app' : '',
  });
}

function renderHint() {
  const i18n = createI18n('ru');
  return render(
    <I18nextProvider i18n={i18n}>
      <DefaultBrowserHint />
    </I18nextProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setWrapper(false);
  setUa(CHROME_UA);
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setWrapper(false);
  vi.restoreAllMocks();
});

describe('условия показа подсказки про браузер по умолчанию', () => {
  it('обычная вкладка Samsung Internet — плашки нет (менять браузер незачем)', () => {
    setUa(SAMSUNG_UA);
    expect(isNonChromeWrapper()).toBe(false);
    renderHint();
    expect(screen.queryByTestId('default-browser-hint')).not.toBeInTheDocument();
  });

  it('обёртка + Chrome — плашки нет', () => {
    setWrapper(true);
    setUa(CHROME_UA);
    expect(isNonChromeWrapper()).toBe(false);
  });

  it('обёртка + Samsung Internet — плашка есть, хотя в UA стоит `Chrome/`', () => {
    setWrapper(true);
    setUa(SAMSUNG_UA);
    expect(isNonChromeWrapper()).toBe(true);
    renderHint();
    expect(screen.getByTestId('default-browser-hint')).toBeInTheDocument();
    expect(screen.getByText('Приложение открыто не в Chrome')).toBeInTheDocument();
    // Текстовый путь стоит рядом с кнопкой ВСЕГДА — кнопка не обязана сработать.
    expect(
      screen.getByText('Настройки телефона → Приложения → Выбор приложений по умолчанию → Браузер → Chrome'),
    ).toBeInTheDocument();
  });

  it('обёртка + браузер без `Chrome/` вовсе — плашка есть', () => {
    setWrapper(true);
    setUa(FIREFOX_UA);
    expect(isNonChromeWrapper()).toBe(true);
  });
});

describe('кнопка и скрытие навсегда', () => {
  it('кнопка ведёт на системный экран выбора приложений по умолчанию', async () => {
    setWrapper(true);
    setUa(SAMSUNG_UA);
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, assign },
    });
    renderHint();
    await userEvent.click(screen.getByTestId('default-browser-open'));
    expect(assign).toHaveBeenCalledWith(DEFAULT_APPS_INTENT);
  });

  it('браузер не понимает intent-ссылку — ничего не ломается, плашка на месте', async () => {
    setWrapper(true);
    setUa(SAMSUNG_UA);
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...window.location,
        assign: () => {
          throw new Error('unsupported scheme');
        },
      },
    });
    renderHint();
    await userEvent.click(screen.getByTestId('default-browser-open'));
    expect(openDefaultAppsSettings()).toBe(false);
    expect(screen.getByTestId('default-browser-hint')).toBeInTheDocument();
  });

  it('«Больше не показывать» — скрывает насовсем, в том числе на другой поверхности', async () => {
    setWrapper(true);
    setUa(SAMSUNG_UA);
    const { unmount } = renderHint();
    await userEvent.click(screen.getByTestId('default-browser-dismiss'));
    expect(screen.queryByTestId('default-browser-hint')).not.toBeInTheDocument();
    unmount();

    // Выбор клиентский и общий для ленты и настроек — как «✕» у промо push.
    expect(shouldShowDefaultBrowserHint()).toBe(false);
    renderHint();
    expect(screen.queryByTestId('default-browser-hint')).not.toBeInTheDocument();
  });
});
