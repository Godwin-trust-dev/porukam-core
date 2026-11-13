import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { SigningPage } from '../src/pages/SigningPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { useViewerStore } from '../src/features/contracts/viewerStore';
import { setActiveLocale } from '../src/shared/activeLocale';

function renderPage(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/contracts/:id/sign" element={<SigningPage />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

// DEV-16b §7 — язык договора на подписании: is_cross_language единственный переключатель
// поведения; официальный язык всегда 'en' (мок), viewer_render считается на запрос по
// Accept-Language (`setActiveLocale` — та же переменная, что читает ApiClient.getLocale).
describe('SigningPage — язык договора (DEV-16b)', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-viewer', kind: 'person', display_name: 'Смотрящий', handle: '@viewer', verification_level: 'basic', has_business_status: false },
    ]);
    useViewerStore.getState().setViewAs('customer');
  });

  it('одноязычная (viewer=en=official) — чистый экран, ни одного языкового элемента (§0.2)', async () => {
    setActiveLocale('en');
    renderPage('/contracts/c-3003/sign');
    await screen.findByTestId('sign-cta');
    expect(screen.queryByText('автоперевод')).not.toBeInTheDocument();
    expect(screen.queryByText(/Официальный текст/)).not.toBeInTheDocument();
  });

  it('разноязычная (viewer=ru, official=en, есть перевод) — бейдж + тихая строка + лист по «показать»', async () => {
    setActiveLocale('ru');
    renderPage('/contracts/c-3003/sign');
    await screen.findByTestId('sign-cta');

    expect(await screen.findByText('автоперевод')).toBeInTheDocument();
    const line = screen.getByRole('button', { name: /Официальный текст — English/ });
    expect(line).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(line);
    expect(line).toHaveAttribute('aria-expanded', 'true');
    // Сноска — только внутри открытого листа/колонки (уникальна для DEV-16b §4).
    expect(await screen.findByText(/действует официальный/)).toBeInTheDocument();
  });

  it('нет рендера на язык смотрящего (viewer=es) — официальный текст + тихая подсказка, без бейджа', async () => {
    setActiveLocale('es');
    renderPage('/contracts/c-3003/sign');
    await screen.findByTestId('sign-cta');

    expect(await screen.findByText(/official version of the agreement/)).toBeInTheDocument();
    expect(screen.getByText(/перевод на ваш язык пока недоступен/i)).toBeInTheDocument();
    expect(screen.queryByText('автоперевод')).not.toBeInTheDocument();
  });

  it('custom_terms (c-3006) — «текст стороны», оригинал не переведён, «Перевести» — заглушка', async () => {
    setActiveLocale('ru');
    renderPage('/contracts/c-3006/sign');
    await screen.findByTestId('sign-cta');

    expect(await screen.findByText('Текст стороны')).toBeInTheDocument();
    expect(screen.getByText('не переводится платформой')).toBeInTheDocument();
    expect(screen.getByText(/Tilda/)).toBeInTheDocument(); // оригинал автора — как есть, не переведён
    expect(screen.getByRole('button', { name: 'Перевести (скоро)' })).toBeDisabled();
  });

  it('нигде на экране нет слова «канон» (DEV-16b §0/§7 ⭐)', async () => {
    setActiveLocale('ru');
    const { container } = renderPage('/contracts/c-3006/sign');
    await screen.findByTestId('sign-cta');
    expect(container.textContent ?? '').not.toMatch(/канон/i);
  });
});
