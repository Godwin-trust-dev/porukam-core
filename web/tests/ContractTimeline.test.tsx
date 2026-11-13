import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import type { RealTimelineEvent } from '@porukam/core';
import { ContractDetailPage } from '../src/pages/ContractDetailPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { server } from '../src/mocks/server';

function renderPage(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/contracts/:id" element={<ContractDetailPage />} />
            <Route path="/contracts/:id/stages/:sid" element={<div data-testid="stage-stub">stage</div>} />
            <Route path="/contracts/:id/amendments/:amendmentId" element={<div data-testid="amendment-stub">amendment</div>} />
            <Route path="/disputes/:disputeId" element={<div data-testid="dispute-stub">dispute</div>} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

async function openTimeline(path: string, title: string) {
  renderPage(path);
  await screen.findByText(title);
  await openCardTab('timeline');
  return screen.findByTestId('timeline');
}

const at = (h: number) => `2026-08-20T${String(h).padStart(2, '0')}:00:00Z`;

/**
 * Хроника договора (ADR-134): подписи `title`/`detail` приходят с бэка, фронт
 * словаря не ведёт; вложенные события (этапы/допники/споры/платежи) свёрнуты
 * одной группой со ссылками на сущность по `subject`; чат — не показывается.
 */
/**
 * Вкладки карточки сделки (замечание владельца 07.09): воронки и шита у
 * карточки больше нет — ВСЕ вкладки стоят в полосе (на телефоне в несколько
 * рядов), поэтому путь человека — прямой клик по вкладке.
 */
async function openCardTab(value: string): Promise<void> {
  await userEvent.click(await screen.findByTestId(`tab-${value}`));
}

describe('ContractDetailPage — вкладка «История» (ADR-134)', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-person-1', kind: 'person', display_name: 'Годвин', handle: '@godwin', verification_level: 'basic', has_business_status: false },
    ]);
  });

  it('сид: подпись с бэка заголовком, а не код; вложенных 4 при 1 собственном — группа раскрыта сразу', async () => {
    const tl = await openTimeline('/contracts/rc-progress-1', 'Ремонт ванной комнаты');
    expect(within(tl).getByText('Договор подписан обеими сторонами')).toBeInTheDocument();
    // Сырой код в собственной ленте договора не печатается.
    expect(within(tl).queryByText('contract.signed')).not.toBeInTheDocument();
    // Вложенные (2 этапа, спор, допник) — не в основной ленте, а в группе.
    expect(within(tl).queryByText('Сантехника')).not.toBeInTheDocument();
    const toggle = screen.getByTestId('timeline-nested-toggle');
    expect(toggle).toHaveTextContent('Вложенные события (4)');
    // Автораскрытие: собственных событий ≤ 2, вложенные есть.
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const nested = screen.getByTestId('timeline-nested');
    // Хронологический порядок — как `order_by(occurred_at)` на бэке.
    const kinds = within(nested).getAllByTestId('timeline-item').map((el) => el.getAttribute('data-kind'));
    expect(kinds).toEqual(['milestone.accepted', 'milestone.submitted', 'dispute.opened', 'amendment.sent']);
    expect(within(nested).getByText('Этап сдан на приёмку')).toBeInTheDocument();
    expect(within(nested).getByText('Срок приёмки — 5 дней с размещения в ЛК')).toBeInTheDocument();
    const links = within(nested).getAllByTestId('timeline-subject-link');
    expect(links.map((l) => l.textContent)).toEqual(['Демонтаж', 'Сантехника', 'Спор по этапу «Стяжка пола»', 'Допсоглашение №2']);
    expect(links[1]).toHaveAttribute('href', '/contracts/rc-progress-1/stages/ms-3-under-acceptance');
    expect(links[2]).toHaveAttribute('href', '/disputes/dsp-open-1');
    expect(links[3]).toHaveAttribute('href', '/contracts/rc-progress-1/amendments/am-seed-1');

    // Клик пользователя важнее умолчания: сворачивается и разворачивается снова.
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('timeline-nested')).not.toBeInTheDocument();
    await userEvent.click(toggle);
    await userEvent.click(within(await screen.findByTestId('timeline-nested')).getAllByTestId('timeline-subject-link')[1]!);
    expect(await screen.findByTestId('stage-stub')).toBeInTheDocument();
  });

  it('3 собственных события — группа свёрнута; фолбэк «Событие» + код; чат отфильтрован; платёж → вкладка «Оплаты»; гарантия → спор по dispute_id', async () => {
    const events: RealTimelineEvent[] = [
      { event_id: 'x1', topic: 'contract.signed', kind: 'contract.signed', nested: false, title: 'Договор подписан обеими сторонами', detail: 'Версия v1, обе подписи', occurred_at: at(9), actor: {}, subject: { type: 'contract', id: 'rc-progress-1' }, payload: {} },
      // Неизвестный фронту kind, без `title` (старый бэк).
      { event_id: 'x2', topic: 'contract.something_new', occurred_at: at(10), actor: {}, subject: { type: 'contract', id: 'rc-progress-1' }, payload: {} },
      // Новый бэк без текста в паке отдаёт `title == kind` — тот же фолбэк.
      { event_id: 'x2b', topic: 'contract.other_new', kind: 'contract.other_new', nested: false, title: 'contract.other_new', detail: null, occurred_at: at(10), actor: {}, subject: { type: 'contract', id: 'rc-progress-1', title: null }, payload: {} },
      // Чат — защита: старый бэк подмешивал переписку в ленту.
      { event_id: 'x3', topic: 'message.created', occurred_at: at(11), actor: {}, subject: { type: 'contract', id: 'rc-progress-1' }, payload: { text: 'Привет, когда начнём?' } },
      // Платёж без названия сущности — «Оплата · id», ссылка = вкладка «Оплаты».
      { event_id: 'x4', topic: 'payment.paid', kind: 'payment.paid', nested: true, title: 'Оплата подтверждена обеими сторонами', detail: null, occurred_at: at(12), actor: {}, subject: { type: 'payment', id: 'pay-1' }, payload: {} },
      // Гарантийная претензия: своей страницы нет — ссылка на спор только при `dispute_id` в payload.
      { event_id: 'x5', topic: 'warranty.claim_submitted', kind: 'warranty.claim_submitted', nested: true, title: 'Подана гарантийная претензия', detail: null, occurred_at: at(13), actor: {}, subject: { type: 'warranty_claim', id: 'wc-1' }, payload: {} },
      { event_id: 'x6', topic: 'warranty.claim_resolved', kind: 'warranty.claim_resolved', nested: true, title: 'Гарантийная претензия урегулирована', detail: null, occurred_at: at(14), actor: {}, subject: { type: 'warranty_claim', id: 'wc-1' }, payload: { dispute_id: 'dsp-w-1' } },
    ];
    server.use(http.get('/v1/contracts/rc-progress-1/timeline', () => HttpResponse.json(events)));

    const tl = await openTimeline('/contracts/rc-progress-1', 'Ремонт ванной комнаты');
    expect(within(tl).getByText('Версия v1, обе подписи')).toBeInTheDocument();
    const items = within(tl).getAllByTestId('timeline-item');
    expect(items.map((el) => el.getAttribute('data-kind'))).toEqual(['contract.signed', 'contract.something_new', 'contract.other_new']);
    // Фолбэк: заголовок — нейтральный, код — отдельным <code>, не заголовком.
    expect(items[1]).toHaveTextContent('Событие');
    expect(items[1]!.querySelector('code')).toHaveTextContent('contract.something_new');
    expect(items[2]).toHaveTextContent('Событие');
    expect(items[2]!.querySelector('code')).toHaveTextContent('contract.other_new');
    // Чат не показывается ни заголовком, ни текстом.
    expect(screen.queryByText(/Привет, когда начнём/)).not.toBeInTheDocument();
    expect(screen.queryByText('message.created')).not.toBeInTheDocument();

    // Собственных событий 3 (> 2) — группа по умолчанию свёрнута.
    expect(screen.getByTestId('timeline-nested-toggle')).toHaveTextContent('Вложенные события (3)');
    expect(screen.getByTestId('timeline-nested-toggle')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('timeline-nested')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('timeline-nested-toggle'));
    const nested = await screen.findByTestId('timeline-nested');
    // Претензия без спора — подпись без ссылки; с `dispute_id` — ссылка на спор.
    expect(within(nested).getByTestId('timeline-subject-label')).toHaveTextContent('Гарантийная претензия · wc-1');
    const links = within(nested).getAllByTestId('timeline-subject-link');
    expect(links.map((l) => l.textContent)).toEqual(['Оплата · pay-1', 'Гарантийная претензия · wc-1']);
    expect(links[1]).toHaveAttribute('href', '/disputes/dsp-w-1');
    const link = links[0]!;
    await userEvent.click(link);
    expect(await screen.findByTestId('payments-panel')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Оплаты/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('пустая хроника — «Событий пока нет.», без группы вложенных', async () => {
    server.use(http.get('/v1/contracts/rc-progress-1/timeline', () => HttpResponse.json([])));
    await openTimeline('/contracts/rc-progress-1', 'Ремонт ванной комнаты');
    expect(screen.getByText('Событий пока нет.')).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-nested-toggle')).not.toBeInTheDocument();
  });
});
