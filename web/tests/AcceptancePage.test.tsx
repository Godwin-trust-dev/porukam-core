import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { AcceptancePage } from '../src/pages/AcceptancePage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { useViewerStore } from '../src/features/contracts/viewerStore';

function renderPage(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/contracts/:id/milestones/:mid/accept" element={<AcceptancePage />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('AcceptancePage (DEV-04)', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      {
        id: 'pf-viewer',
        kind: 'person',
        display_name: 'Смотрящий',
        handle: '@viewer',
        verification_level: 'basic',
        has_business_status: false,
      },
    ]);
    useViewerStore.getState().setViewAs('customer');
  });

  it('гейт роли: не-заказчик видит приглашение переключиться (приёмка §1)', async () => {
    useViewerStore.getState().setViewAs('contractor');
    renderPage('/contracts/c-9001/milestones/ms-9001/accept');
    expect(await screen.findByText('Приёмка доступна только заказчику')).toBeInTheDocument();
  });

  it('все пункты приняты → «Принять этап» → церемония (приёмка 1, 5)', async () => {
    renderPage('/contracts/c-9001/milestones/ms-9001/accept');
    const checklist = await screen.findByTestId('acceptance-checklist');
    const radios = within(checklist).getAllByRole('radio', { name: 'Принять' });
    expect(radios).toHaveLength(3);
    for (const r of radios) await userEvent.click(r);

    const acceptBtn = screen.getByTestId('accept-milestone');
    await waitFor(() => expect(acceptBtn).toBeEnabled());
    await userEvent.click(acceptBtn);
    await userEvent.click(await screen.findByTestId('confirm-accept'));

    expect(await screen.findByText('Этап принят — по рукам!')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Готово' }));
  });

  it('«Замечание» требует файл и описание перед тем как включить возврат (приёмка 2)', async () => {
    renderPage('/contracts/c-9001/milestones/ms-9001/accept');
    const checklist = await screen.findByTestId('acceptance-checklist');
    const remarkRadios = within(checklist).getAllByRole('radio', { name: 'Замечание' });
    await userEvent.click(remarkRadios[0]!);

    expect(screen.queryByTestId('return-milestone')).toBeDisabled();

    const note = screen.getByLabelText('Опишите замечание');
    await userEvent.type(note, 'Плинтус не закреплён');
    expect(screen.getByTestId('return-milestone')).toBeDisabled();

    const fileInput = screen.getByLabelText('Приложить файл');
    const file = new File(['x'], 'фото.jpg', { type: 'image/jpeg' });
    await userEvent.upload(fileInput, file);

    // Остальные пункты по-прежнему без решения — возврат недоступен, пока не решены все.
    expect(screen.getByTestId('return-milestone')).toBeDisabled();

    const acceptRadios = within(checklist).getAllByRole('radio', { name: 'Принять' });
    await userEvent.click(acceptRadios[1]!);
    await userEvent.click(acceptRadios[2]!);

    await waitFor(() => expect(screen.getByTestId('return-milestone')).toBeEnabled());
  });

  it('«ожидаем сдачу» показывает срок; «Написать в чат» виден — чат включён (ADR-112)', async () => {
    renderPage('/contracts/c-9002/milestones/ms-9002/accept');
    expect(await screen.findByText('Осталось 2 дней')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Написать в чат' })).toBeInTheDocument();
  });

  it('автоприёмка — банер + ссылка восстановления срока', async () => {
    renderPage('/contracts/c-9003/milestones/ms-9003/accept');
    expect(await screen.findByText('Этап принят автоматически')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Восстановить срок' })).toBeInTheDocument();
  });
});
