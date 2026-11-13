import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { createI18n } from '@porukam/i18n';
import { RetentionNotice } from '../src/features/contracts/RetentionNotice';
import { SigningPage } from '../src/pages/SigningPage';
import { ContractDetailPage } from '../src/pages/ContractDetailPage';
import { PreviewStepPage } from '../src/pages/contract-new/PreviewStepPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { useContractNewStore } from '../src/features/contractNew/draftStore';
import { server } from '../src/mocks/server';

/**
 * ADR-137, требование 9: ограничение срока хранения документов размещается
 * при создании сделки и видно там же и так же, как обещание — блок
 * `RetentionNotice` на превью мастера, экране подписания и обзоре карточки.
 * Значения — `GET /evidence/retention-policy` с фолбэком на константы ADR;
 * числа — через плюрализацию i18n (ru: 3 месяца / 1 год / 10 дней).
 */
function wrap(ui: JSX.Element, path = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/" element={ui} />
            <Route path="/contracts/new/preview" element={ui} />
            <Route path="/contracts/:id/sign" element={ui} />
            <Route path="/contracts/:id" element={ui} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

const POLICY_URL = '/v1/evidence/retention-policy';

describe('RetentionNotice — сроки хранения документов (ADR-137 §9)', () => {
  it('значения из API: 3 месяца / 1 год / 10 дней (плюрализация ru), обещание — заголовком', async () => {
    wrap(<RetentionNotice />);
    const box = await screen.findByTestId('retention-notice');
    // Дождаться ответа мока, а не фолбэка — источник помечен на контейнере.
    await screen.findByText((_, el) => el?.getAttribute('data-source') === 'api');
    expect(within(box).getByText('Подлинность документов подтверждаем бессрочно')).toBeInTheDocument();
    const summary = within(box).getByText(/Сами файлы храним/);
    expect(summary.textContent).toContain('3 месяца');
    expect(summary.textContent).toContain('1 год');
    expect(summary.textContent).toContain('10 дней');
    expect(summary.textContent).not.toMatch(/\{\{/);
  });

  it('значения действительно берутся из ответа: 60 дней → «2 месяца», 730 → «2 года», 5 → «5 дней»', async () => {
    server.use(
      http.get(POLICY_URL, () =>
        HttpResponse.json({ hot_days: 60, archive_days: 730, notice_days: 5, dispute_pause_cap_days: 180, hashes_forever: true }),
      ),
    );
    wrap(<RetentionNotice />);
    const summary = await screen.findByText(/2 месяца/);
    expect(summary.textContent).toContain('2 года');
    expect(summary.textContent).toContain('5 дней');
  });

  it('API недоступен (500) → фолбэк ADR-137: блок всё равно есть, с теми же сроками', async () => {
    server.use(http.get(POLICY_URL, () => HttpResponse.json({ detail: 'boom' }, { status: 500 })));
    wrap(<RetentionNotice />);
    const summary = await screen.findByText(/Сами файлы храним/);
    expect(summary.textContent).toContain('3 месяца');
    expect(summary.textContent).toContain('1 год');
    expect(summary.textContent).toContain('10 дней');
    // Ошибка запроса не выкидывает ретраи бесконечно: источник остаётся «fallback».
    expect(screen.getByTestId('retention-notice').getAttribute('data-source')).toBe('fallback');
  });

  it('`null` по одному полю (категория не засеяна) → фолбэк только по нему', async () => {
    server.use(
      http.get(POLICY_URL, () =>
        HttpResponse.json({ hot_days: 30, archive_days: null, notice_days: 10, dispute_pause_cap_days: null, hashes_forever: true }),
      ),
    );
    wrap(<RetentionNotice />);
    const summary = await screen.findByText(/1 месяц /);
    expect(summary.textContent).toContain('1 год');
  });

  it('«Подробнее» раскрывает пояснение на месте (aria-expanded), «Свернуть» прячет; спор — 6 месяцев', async () => {
    wrap(<RetentionNotice />);
    const toggle = await screen.findByRole('button', { name: 'Подробнее' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('retention-notice-details')).not.toBeInTheDocument();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const details = screen.getByTestId('retention-notice-details');
    expect(details).toHaveTextContent('Хеши и метки времени');
    expect(details).toHaveTextContent('не более чем на 6 месяцев');
    expect(details).toHaveTextContent('За 10 дней до удаления');

    await userEvent.click(screen.getByRole('button', { name: 'Свернуть' }));
    expect(screen.queryByTestId('retention-notice-details')).not.toBeInTheDocument();
  });

  it('compact: одна строка (обещание) + «Подробнее»; факты — внутри раскрытия', async () => {
    wrap(<RetentionNotice variant="compact" />);
    const box = await screen.findByTestId('retention-notice');
    expect(within(box).getByText('Подлинность документов подтверждаем бессрочно')).toBeInTheDocument();
    expect(within(box).queryByText(/Сами файлы храним/)).not.toBeInTheDocument();
    await userEvent.click(within(box).getByRole('button', { name: 'Подробнее' }));
    expect(within(box).getByText(/Сами файлы храним/)).toBeInTheDocument();
  });
});

describe('RetentionNotice — присутствие на трёх экранах', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-person-1', kind: 'person', display_name: 'Годвин', handle: '@godwin', verification_level: 'basic', has_business_status: false },
    ]);
  });

  it('мастер: шаг «Превью» — блок перед кнопкой отправки', async () => {
    useContractNewStore.getState().setDraftId('rc-draft-1');
    useContractNewStore.getState().setClientOption('service');
    wrap(<PreviewStepPage />, '/contracts/new/preview');
    const step = await screen.findByTestId('preview-step');
    const notice = await within(step).findByTestId('retention-notice');
    expect(notice.getAttribute('data-variant')).toBe('full');
    // Блок стоит выше кнопки отправки (DOM-порядок).
    const send = within(step).getByTestId('send-for-review');
    expect(notice.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('экран подписания (реальный контур, заморожен) — компактно над кнопками подписи', async () => {
    wrap(<SigningPage />, '/contracts/rc-frozen-1/sign');
    const notice = await screen.findByTestId('retention-notice');
    expect(within(notice).getByText('Подлинность документов подтверждаем бессрочно')).toBeInTheDocument();
    const cta = await screen.findByTestId('sign-cta');
    expect(notice.compareDocumentPosition(cta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('карточка договора: вкладка «Условия» — свёрнуто (одна строка + «Подробнее»)', async () => {
    wrap(<ContractDetailPage />, '/contracts/rc-review-1');
    await screen.findByText('Сборка мебели — гостиная');
    // Доска B: юр-блоки живут на вкладке «Условия», обзор — стороны/сумма/CTA.
    await userEvent.click(screen.getByRole('tab', { name: /Условия/ }));
    const notice = await screen.findByTestId('retention-notice');
    expect(notice.getAttribute('data-variant')).toBe('compact');
    expect(within(notice).queryByText(/Сами файлы храним/)).not.toBeInTheDocument();
    expect(within(notice).getByRole('button', { name: 'Подробнее' })).toBeInTheDocument();
  });
});
