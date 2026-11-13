import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { ChatPage } from '../src/pages/ChatPage';
import { ChatThreadPage } from '../src/pages/ChatThreadPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { resetChat } from '../src/mocks/chatHandlers';
import { setViewportWidth, WIDTH_DESKTOP } from './viewport';

/** Чат по договору (ADR-112): список диалогов + тред с отправкой. */

/** Печатает текущий URL — проверяем, что выбор/навигация живут в нём. */
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
            <Route path="/chat/:contractId" element={<ChatThreadPage />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('Чат по договору', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.setState({ activeProfileId: 'pf-person-1' });
    resetChat();
  });

  it('список диалогов: договор, последнее сообщение, непрочитанное', async () => {
    renderAt('/chat');
    const list = await screen.findByTestId('chat-threads');
    expect(within(list).getByText('Ремонт ванной комнаты')).toBeInTheDocument();
    expect(within(list).getByText(/Отлично, жду!/)).toBeInTheDocument();
  });

  it('мобайл: клик по диалогу — обычная навигация на /chat/{contractId}', async () => {
    renderAt('/chat');
    const list = await screen.findByTestId('chat-threads');
    await userEvent.click(within(list).getByText('Ремонт ванной комнаты'));
    await waitFor(() =>
      expect(screen.getByTestId('url').textContent).toBe('/chat/rc-progress-1'),
    );
  });

  it('десктоп (DEV-19 §2): клик по диалогу — тред в detail-колонке, выбор в ?sel=', async () => {
    const restore = setViewportWidth(WIDTH_DESKTOP);
    try {
      renderAt('/chat');
      const list = await screen.findByTestId('chat-threads');
      await userEvent.click(within(list).getByText('Ремонт ванной комнаты'));
      // Со списка не ушли — выбор отражён в URL.
      await waitFor(() =>
        expect(screen.getByTestId('url').textContent).toBe('/chat?sel=rc-progress-1'),
      );
      const pane = screen.getByTestId('master-detail-pane');
      const messages = await within(pane).findByTestId('chat-messages');
      await waitFor(() =>
        expect(within(messages).getByText('Отлично, жду!')).toBeInTheDocument(),
      );
      // Стрелки «назад» в панели нет — список рядом.
      expect(within(pane).queryByLabelText('К списку диалогов')).not.toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it('тред: сообщения обеих сторон, отправка добавляет пузырь', async () => {
    renderAt('/chat/rc-progress-1');
    const messages = await screen.findByTestId('chat-messages');
    await waitFor(() =>
      expect(within(messages).getByText(/Плитку начали класть/)).toBeInTheDocument(),
    );
    expect(within(messages).getByText('Отлично, жду!')).toBeInTheDocument();

    await userEvent.type(screen.getByTestId('chat-input'), 'Фото получил, спасибо!');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    await waitFor(() =>
      expect(within(messages).getByText('Фото получил, спасибо!')).toBeInTheDocument(),
    );
  });
});
