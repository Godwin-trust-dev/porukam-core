import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '@porukam/i18n';
import { LanguageSwitcher, Toast } from '@porukam/ui';
import { useAuthStore } from '../src/features/auth/authStore';
import { useGuestLocaleStore } from '../src/features/locale/localeStore';
import { useLanguageSwitcherProps } from '../src/features/locale/useLanguageSwitcherProps';
import { useLocaleResolution } from '../src/features/locale/useLocaleResolution';
import { getMe } from '../src/mocks/profileDb';
import { server } from '../src/mocks/server';

function Harness(): JSX.Element {
  const switcherProps = useLanguageSwitcherProps();
  const { toastText } = useLocaleResolution();
  return (
    <>
      <LanguageSwitcher variant="chip" {...switcherProps} />
      {toastText ? <Toast text={toastText} /> : null}
    </>
  );
}

function renderHarness(lng = 'ru') {
  const i18n = createI18n(lng);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { i18n, ...render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <Harness />
      </I18nextProvider>
    </QueryClientProvider>,
  ) };
}

// DEV-16a §7 — «выбор: гость → память, залогинен → PATCH; changeLanguage без reload».
describe('Выбор языка — гость vs залогинен (DEV-16a §3/§7)', () => {
  beforeEach(() => {
    useAuthStore.getState().logout();
    useGuestLocaleStore.setState({ locale: null });
    sessionStorage.clear();
  });
  afterEach(() => {
    useAuthStore.getState().logout();
    useGuestLocaleStore.setState({ locale: null });
    sessionStorage.clear();
  });

  it('гость: выбор языка меняет i18n мгновенно и запоминается в sessionStorage (не PATCH)', async () => {
    const user = userEvent.setup();
    const { i18n } = renderHarness('ru');
    await user.click(await screen.findByRole('button', { name: /Язык интерфейса/ }));
    await user.click(await screen.findByRole('option', { name: /Español/ }));
    await waitFor(() => expect(i18n.language).toBe('es'));
    expect(useGuestLocaleStore.getState().locale).toBe('es');
    expect(sessionStorage.getItem('porukam.guest_locale')).toBe('es');
  });

  it('залогинен: выбор языка PATCH-ит профиль и переживает «перезагрузку» (новый i18n на том же профиле)', async () => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    const user = userEvent.setup();
    const { i18n } = renderHarness('ru');
    await user.click(await screen.findByRole('button', { name: /Язык интерфейса/ }));
    await user.click(await screen.findByRole('option', { name: /Deutsch/ }));
    await waitFor(() => expect(i18n.language).toBe('de'));
    await waitFor(() => expect(getMe().locale).toBe('de'));
  });

  it('гостевой выбор переживает вход: язык применён и ЗАКРЕПЛЁН в профиле (ADR-095 §5)', async () => {
    // Человек выбирает язык на /welcome, потом регистрируется. `me.locale` пуст —
    // PATCH-ить до входа было некому, и без доезда выбор остался бы в
    // sessionStorage: первый экран после входа встретил бы языком браузера, а на
    // другом устройстве — снова автоопределением.
    const { patchProfile } = await import('../src/mocks/profileDb');
    patchProfile({ locale: null });
    useGuestLocaleStore.setState({ locale: 'de' });
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });

    const { i18n } = renderHarness('ru');

    await waitFor(() => expect(i18n.language).toBe('de'));
    await waitFor(() => expect(getMe().locale).toBe('de'));
  });

  it('профиль с языком сильнее гостевого остатка — доезд не перетирает выбранное (ADR-095 §5)', async () => {
    // Обратная сторона правила выше: `me.locale` есть, значит человек уже выбирал
    // язык залогиненным. Гостевой остаток в sessionStorage (другая вкладка, чужой
    // /welcome) не должен его переигрывать.
    const { patchProfile } = await import('../src/mocks/profileDb');
    patchProfile({ locale: 'es' });
    useGuestLocaleStore.setState({ locale: 'de' });
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });

    const { i18n } = renderHarness('ru');

    await waitFor(() => expect(i18n.language).toBe('es'));
    expect(getMe().locale).toBe('es');
  });

  it('отключённая локаль профиля → EN + тост «временно недоступен»', async () => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    // Мок-каталог с feat/l10n-launch-surfaces отдаёт ВСЕ языки включёнными (§C:
    // включаем по готовности пакета, и мок строится из реестра пакетов), поэтому
    // «выключено админом» — состояние ответа эндпоинта, а не мок-данных: подменяем
    // ответ на список, где ar выключен. Сценарий тот же, источник факта — честный.
    server.use(
      http.get('/v1/locales', () =>
        HttpResponse.json([
          { code: 'en', self_name: 'English', english_name: 'English', quality: 'human', enabled: true, dir: 'ltr' },
          { code: 'ru', self_name: 'Русский', english_name: 'Russian', quality: 'human', enabled: true, dir: 'ltr' },
          { code: 'ar', self_name: 'العربية', english_name: 'Arabic', quality: 'machine', enabled: false, dir: 'rtl' },
        ]),
      ),
    );
    const { patchProfile } = await import('../src/mocks/profileDb');
    patchProfile({ locale: 'ar' });
    const { i18n } = renderHarness('ru');
    await waitFor(() => expect(i18n.language).toBe('en'));
    expect(await screen.findByText(/временно недоступен/)).toBeInTheDocument();
  });
});

// docs/tasks/Задача_fix_web-locales-switcher.md §4.2 — /v1/locales
// недоступен/пуст (реальный бэкенд до фикса именно так и отдавал — записи
// без self_name/enabled, что для фронта неотличимо от пустого списка) не
// должен принудительно откатывать интерфейс на EN независимо от языка
// браузера — резолвим по бандл-локалям (en/ru).
describe('Фолбэк на бандл-локали, когда /v1/locales пуст/недоступен (DEV-16a §3/§7)', () => {
  const originalLanguage = window.navigator.language;

  beforeEach(() => {
    useAuthStore.getState().logout();
    useGuestLocaleStore.setState({ locale: null });
    sessionStorage.clear();
    Object.defineProperty(window.navigator, 'language', { value: 'ru', configurable: true });
  });
  afterEach(() => {
    useAuthStore.getState().logout();
    useGuestLocaleStore.setState({ locale: null });
    sessionStorage.clear();
    Object.defineProperty(window.navigator, 'language', { value: originalLanguage, configurable: true });
  });

  it('пустой список ([]) — гость с ru-браузером резолвится в ru, а не принудительно в en', async () => {
    server.use(http.get('/v1/locales', () => HttpResponse.json([])));
    const { i18n } = renderHarness('ru');
    await waitFor(() => expect(i18n.language).toBe('ru'));
  });

  it('ошибка запроса — гость с ru-браузером всё равно резолвится в ru (не зависает без резолюции)', async () => {
    server.use(http.get('/v1/locales', () => HttpResponse.json(null, { status: 500 })));
    const { i18n } = renderHarness('ru');
    await waitFor(() => expect(i18n.language).toBe('ru'));
  });
});
