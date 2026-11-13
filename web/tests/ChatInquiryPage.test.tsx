import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { ChatInquiryPage } from '../src/pages/ChatInquiryPage';
import { ChatPage } from '../src/pages/ChatPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { resetChat } from '../src/mocks/chatHandlers';

/**
 * «Запрос на сотрудничество» (ADR-116): мини-форма на /chat/new создаёт
 * минимальный черновик + первое сообщение и ведёт в тред. Кнопка входа —
 * на /chat.
 */

function LocationProbe(): JSX.Element {
  const { pathname, search } = useLocation();
  return <span data-testid="url">{`${pathname}${search}`}</span>;
}

function renderAt(path: string): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={createI18n('ru')}>
        <MemoryRouter initialEntries={[path]}>
          <LocationProbe />
          <Routes>
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/chat/new" element={<ChatInquiryPage />} />
            <Route path="/chat/:contractId" element={<div data-testid="thread-stub" />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('Запрос на сотрудничество (ADR-116)', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.setState({ activeProfileId: 'pf-person-1' });
    resetChat();
  });

  it('кнопка «Начать переговоры» на /chat ведёт на /chat/new', async () => {
    renderAt('/chat');
    await userEvent.click(await screen.findByTestId('chat-inquiry-cta'));
    await waitFor(() => expect(screen.getByTestId('url').textContent).toBe('/chat/new'));
  });

  it('поиск по хендлу → тип «Услуга» → шаблон в сообщении → отправка создаёт черновик и ведёт в тред', async () => {
    renderAt('/chat/new');
    const page = await screen.findByTestId('chat-inquiry');

    // Контрагент — по поиску хендла.
    await userEvent.type(screen.getByTestId('inquiry-search'), 'masterremont');
    const results = await screen.findByTestId('inquiry-results');
    await userEvent.click(within(results).getByRole('button', { name: /masterremont/ }));

    // Тип работы: «Услуга» (client_option, код резолвит сервер).
    await userEvent.click(within(page).getByRole('radio', { name: /Услуга/ }));

    // Шаблон уже подставлен.
    const message = screen.getByTestId('inquiry-message') as HTMLTextAreaElement;
    expect(message.value).toContain('сотрудничество');

    await userEvent.click(screen.getByTestId('inquiry-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('url').textContent).toMatch(/^\/chat\/(?!new$).+/);
    });
    expect(screen.getByTestId('thread-stub')).toBeInTheDocument();
  });
});
