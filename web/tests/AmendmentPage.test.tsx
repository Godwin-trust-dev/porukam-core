import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { http, HttpResponse } from 'msw';
import { AmendmentPage } from '../src/pages/AmendmentPage';
import { ContractDetailPage } from '../src/pages/ContractDetailPage';
import { DisputePage } from '../src/pages/DisputePage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { server } from '../src/mocks/server';
import {
  createAmendment,
  createAmendmentSignatureRequest,
  freezeAmendment,
  getAmendment,
  getContract,
  listAmendmentSignatureRequests,
  rejectAmendment,
  sendAmendment,
  signSignatureRequest,
  withdrawAmendment,
} from '../src/mocks/realContractsDb';
import { getDispute } from '../src/mocks/disputesDb';

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={createI18n('ru')}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/contracts/:id/amendments/:amendmentId" element={<AmendmentPage />} />
            <Route path="/contracts/:id" element={<ContractDetailPage />} />
            <Route path="/disputes/:disputeId" element={<DisputePage />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

/**
 * Экран допсоглашения (Э4.5 бэкенда, ADR-131 §3) поверх MSW-зеркала
 * `realContractsDb`: rc-progress-1 — подписанный договор, Годвин
 * (`pf-person-1`, `u-1001`) — ИСПОЛНИТЕЛЬ; сиды `am-seed-signed-1`
 * (подписан, прочее условие) и `am-seed-1` (скидка по разногласию
 * `dsp-discount-1`: плитка 45000 → 40000 RUB, на согласовании).
 */
describe('AmendmentPage — экран допсоглашения', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-person-1', kind: 'person', display_name: 'Годвин', handle: '@godwin', verification_level: 'basic', has_business_status: false },
    ]);
  });

  it('скидка по спору: «было → станет» по этапу и по сумме договора, анти-waiver из payload, статус «На согласовании»', async () => {
    renderAt('/contracts/rc-progress-1/amendments/am-seed-1');
    expect(await screen.findByTestId('amendment-title')).toHaveTextContent('Допсоглашение №2');
    expect(screen.getByTestId('amendment-status')).toHaveTextContent('На согласовании');
    expect(screen.getByTestId('amendment-reason')).toHaveTextContent('Скидка по разногласию');

    const change = await screen.findByTestId('amendment-change');
    expect(change).toHaveTextContent('Изменение этапа');
    // Цель — из живого дерева этапов (ms-3 «Плитка»), новое значение — из payload.
    await within(change).findByText('Плитка');
    expect(change).toHaveTextContent(/Было:\s*45\s?000/);
    expect(change).toHaveTextContent(/Станет:\s*40\s?000/);
    expect(change).toHaveTextContent(/Изменение суммы:\s*[−-]5\s?000/);
    expect(screen.getByTestId('amendment-anti-waiver')).toHaveTextContent('только полосу затирки');

    // Сумма договора: живой итог по листьям (45000, остальные листья без суммы) → 40000.
    const total = screen.getByTestId('amendment-total');
    expect(total).toHaveTextContent(/Было:\s*45\s?000/);
    expect(total).toHaveTextContent(/Станет:\s*40\s?000/);

    // Под согласованием версии ещё нет — «Подписать» заморозит; «Вернуть на
    // доработку» — только адресату pending-заявки, здесь её нет.
    expect(screen.getByTestId('amendment-sign')).toBeEnabled();
    expect(screen.queryByTestId('amendment-return')).not.toBeInTheDocument();
    expect(screen.queryByTestId('amendment-send')).not.toBeInTheDocument();
  });

  it('«Подписать» из under_review одним нажатием: заморозка → заявка → подпись на integrity_hash; вторая сторона ещё не подписала', async () => {
    renderAt('/contracts/rc-progress-1/amendments/am-seed-1');
    await userEvent.click(await screen.findByTestId('amendment-sign'));

    expect(await screen.findByText('Одна подпись есть — ждём вторую')).toBeInTheDocument();
    expect(screen.getByTestId('amendment-status')).toHaveTextContent('Ждём подписи');
    // Подпись легла на hash замороженной версии допника (инвариант CLAUDE.md).
    const a = getAmendment('am-seed-1');
    expect(a.negotiation_status).toBe('awaiting_signatures');
    expect(a.frozen_version_id).not.toBeNull();
    const [req] = listAmendmentSignatureRequests('am-seed-1');
    expect(req?.side).toBe('contractor');
    expect(req?.status).toBe('signed');
    expect(req?.amendment_id).toBe('am-seed-1');
    // Договор допником НЕ тронут, пока нет второй подписи.
    expect(getContract('rc-progress-1').total?.amount).toBe('45000.00');
    // Хроника допника — события amendment.* с человеческими подписями.
    const timeline = screen.getByTestId('amendment-timeline');
    expect(timeline).toHaveTextContent('Версия зафиксирована');
    expect(timeline).toHaveTextContent('Сторона подписала');
  });

  it('вторая подпись — финальная: signed, изменения применены к дереву (сумма договора 40000), церемония', async () => {
    // Первую подпись ставит контрагент (заказчик, u-2001) — напрямую в моке
    // (`getMe()` мок-бэка — всегда Годвин, «переключить пользователя» по HTTP нельзя).
    const version = freezeAmendment('am-seed-1');
    const req = createAmendmentSignatureRequest('am-seed-1', { side: 'customer', version_id: version.id, signatory_user_id: 'u-2001' });
    signSignatureRequest(req.id, { version_hash: version.integrity_hash }, 'u-2001');

    // Годвин (исполнитель) — его подпись вторая и финальная.
    renderAt('/contracts/rc-progress-1/amendments/am-seed-1');
    expect(await screen.findByTestId('amendment-sign')).toBeInTheDocument();
    expect(screen.getAllByText('Подписано')).toHaveLength(1);
    await userEvent.click(screen.getByTestId('amendment-sign'));

    expect(await screen.findByTestId('amendment-signed')).toBeInTheDocument();
    expect(await screen.findByText('Допсоглашение подписано — по рукам!', { selector: 'h2, h3, p, div' })).toBeInTheDocument();
    expect(getAmendment('am-seed-1').negotiation_status).toBe('signed');
    expect(getContract('rc-progress-1').total?.amount).toBe('40000.00');
    // После применения «стало» — живая сумма, «было» восстановлено из дельты.
    await waitFor(() => expect(screen.getByTestId('amendment-total')).toHaveTextContent(/Стало:\s*40\s?000/));
    expect(screen.queryByTestId('amendment-sign')).not.toBeInTheDocument();
  });

  it('подписанный допник (прочее условие): без кнопок, текст условия и подписи обеих сторон', async () => {
    renderAt('/contracts/rc-progress-1/amendments/am-seed-signed-1');
    expect(await screen.findByTestId('amendment-title')).toHaveTextContent('Допсоглашение №1');
    expect(screen.getByTestId('amendment-status')).toHaveTextContent('Подписан');
    expect(screen.getByTestId('amendment-custom-terms')).toHaveTextContent('Шумные работы');
    expect(screen.getByTestId('amendment-signed')).toBeInTheDocument();
    expect(screen.queryByTestId('amendment-sign')).not.toBeInTheDocument();
    expect(screen.queryByTestId('amendment-total')).not.toBeInTheDocument(); // дельты нет — итог не показываем
    expect(screen.getAllByText('Подписано')).toHaveLength(2);
  });

  it('черновик: «Отправить на согласование» → under_review, «Подписать» появляется', async () => {
    const draft = createAmendment(
      'rc-progress-1',
      { reason: 'Добавить этап затирки', changes: [{ type: 'add_milestone', payload: { title: 'Затирка швов', amount: '3000.00', currency: 'RUB' } }] },
      'u-1001',
    );
    renderAt(`/contracts/rc-progress-1/amendments/${draft.id}`);
    expect(await screen.findByTestId('amendment-send')).toBeInTheDocument();
    expect(screen.queryByTestId('amendment-sign')).not.toBeInTheDocument();
    expect(screen.getByTestId('amendment-changes')).toHaveTextContent('Новый этап');
    expect(screen.getByTestId('amendment-changes')).toHaveTextContent('Затирка швов');
    expect(screen.getByTestId('amendment-total')).toHaveTextContent(/Станет:\s*48\s?000/);

    await userEvent.click(screen.getByTestId('amendment-send'));
    expect(await screen.findByTestId('amendment-sign')).toBeInTheDocument();
    expect(screen.getByTestId('amendment-status')).toHaveTextContent('На согласовании');
  });

  it('адресат pending-заявки может вернуть допник на доработку с комментарием → under_review, раунд аннулирован', async () => {
    // pending-заявка на свою сторону появляется только из цепочки «Подписать»
    // (свою сторону маршрутирует только она сама — `NotThisSidePartyError`):
    // роняем последний шаг (сам `sign`), чтобы заявка осталась pending.
    server.use(http.post('/v1/signature-requests/:id/sign', () => HttpResponse.json({ status: 503, code: 'unavailable', title: 'Недоступно' }, { status: 503 })));
    renderAt('/contracts/rc-progress-1/amendments/am-seed-1');
    await userEvent.click(await screen.findByTestId('amendment-sign'));
    expect(await screen.findByTestId('amendment-error')).toBeInTheDocument();
    server.resetHandlers();

    // Заявка pending и адресована мне — есть «Вернуть на доработку».
    const returnBtn = await screen.findByTestId('amendment-return');
    await userEvent.click(returnBtn);
    await userEvent.type(screen.getByTestId('amendment-return-comment'), 'Скидка мала — обсудим');
    await userEvent.click(screen.getByTestId('amendment-return-confirm'));

    await waitFor(() => expect(getAmendment('am-seed-1').negotiation_status).toBe('under_review'));
    expect(getAmendment('am-seed-1').frozen_version_id).toBeNull();
    expect(await screen.findByText('Возвращено на доработку')).toBeInTheDocument();
    expect(screen.queryByTestId('amendment-return')).not.toBeInTheDocument();
  });

  it('хроника допника: подписи `title`/`detail` с бэка; без подписи — «Событие» + код, не сырой topic (ADR-134)', async () => {
    server.use(
      http.get('/v1/amendments/am-seed-1/timeline', () =>
        HttpResponse.json([
          { event_id: 'a1', topic: 'amendment.sent', kind: 'amendment.sent', nested: true, title: 'Допсоглашение отправлено на согласование', detail: 'Изменений: 1', occurred_at: '2026-08-24T12:00:01Z', actor: {}, subject: { type: 'amendment', id: 'am-seed-1', title: null }, payload: {} },
          { event_id: 'a2', topic: 'amendment.something_new', kind: 'amendment.something_new', nested: true, title: 'amendment.something_new', detail: null, occurred_at: '2026-08-24T12:05:00Z', actor: {}, subject: { type: 'amendment', id: 'am-seed-1', title: null }, payload: {} },
        ]),
      ),
    );
    renderAt('/contracts/rc-progress-1/amendments/am-seed-1');
    const timeline = await screen.findByTestId('amendment-timeline');
    const items = await within(timeline).findAllByTestId('amendment-timeline-item');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Допсоглашение отправлено на согласование');
    expect(items[0]).toHaveTextContent('Изменений: 1');
    expect(items[1]).toHaveTextContent('Событие');
    expect(items[1]!.querySelector('code')).toHaveTextContent('amendment.something_new');
  });

  it('подписанный допник: у каждой подписи — время подписи (signed_at заявки)', async () => {
    renderAt('/contracts/rc-progress-1/amendments/am-seed-signed-1');
    expect(await screen.findByTestId('amendment-title')).toBeInTheDocument();
    // Сид: заказчик 2026-08-11 10:40Z, исполнитель 11:20Z — обе даты на экране.
    expect(screen.getAllByText(/11 авг\./).length).toBeGreaterThanOrEqual(2);
  });

  it('вторая сторона (не инициатор) отклоняет допник с причиной → rejected_by_counterparty; скидка по спору снята, спор снова open', async () => {
    // am-seed-1 предложил заказчик u-2001; Годвин (u-1001) — вторая сторона.
    renderAt('/contracts/rc-progress-1/amendments/am-seed-1');
    const rejectBtn = await screen.findByTestId('amendment-reject');
    expect(screen.queryByTestId('amendment-withdraw')).not.toBeInTheDocument();
    expect(getDispute('dsp-discount-1', 'pf-person-1').status).toBe('awaiting_discount');

    await userEvent.click(rejectBtn);
    await userEvent.type(screen.getByTestId('amendment-close-reason'), 'Скидка не покрывает переделку');
    await userEvent.click(screen.getByTestId('amendment-close-confirm'));

    await waitFor(() => expect(getAmendment('am-seed-1').negotiation_status).toBe('rejected_by_counterparty'));
    expect(await screen.findByTestId('amendment-closed-text')).toHaveTextContent('Вторая сторона отклонила допсоглашение');
    expect(screen.getByTestId('amendment-status')).toHaveTextContent('Отклонён контрагентом');
    expect(screen.queryByTestId('amendment-sign')).not.toBeInTheDocument();
    expect(screen.queryByTestId('amendment-reject')).not.toBeInTheDocument();
    // Хроника: событие с причиной.
    const timeline = screen.getByTestId('amendment-timeline');
    expect(timeline).toHaveTextContent('Отклонено второй стороной');
    expect(timeline).toHaveTextContent('Скидка не покрывает переделку');
    // Подписчик спора (ADR-131 §3): предложение отклонено, спор вернулся в open.
    const dispute = getDispute('dsp-discount-1', 'pf-person-1');
    expect(dispute.status).toBe('open');
    expect(dispute.discount_agreements[0]?.status).toBe('declined');
    expect(dispute.discount_agreements[0]?.decided_by_id).toBe('u-1001');
    // Договор допником не тронут.
    expect(getContract('rc-progress-1').total?.amount).toBe('45000.00');
  });

  it('карточка спора после отклонения допника-скидки: callout «ждёт подписи» исчез, статус «Открыто»', async () => {
    rejectAmendment('am-seed-1', { reason: '' }, 'u-1001');
    renderAt('/disputes/dsp-discount-1');
    expect(await screen.findByTestId('dispute-page')).toBeInTheDocument();
    expect(within(screen.getByTestId('dispute-status')).getByText('Открыто')).toBeInTheDocument();
    expect(screen.queryByTestId('dispute-pending-discount-link')).not.toBeInTheDocument();
    expect(screen.getByTestId('dispute-feed')).toHaveTextContent('Скидка отклонена');
  });

  it('инициатор отзывает свой допник (после отправки) → withdrawn_by_initiator; «Отклонить» ему недоступно', async () => {
    const draft = createAmendment(
      'rc-progress-1',
      { reason: 'Перенести срок плитки', changes: [{ type: 'modify_milestone', target: 'ms-3', payload: { deadline: '2026-10-01' } }] },
      'u-1001',
    );
    sendAmendment(draft.id);
    renderAt(`/contracts/rc-progress-1/amendments/${draft.id}`);
    const withdrawBtn = await screen.findByTestId('amendment-withdraw');
    expect(screen.queryByTestId('amendment-reject')).not.toBeInTheDocument();

    await userEvent.click(withdrawBtn);
    // Причина необязательна — подтверждаем без неё.
    await userEvent.click(screen.getByTestId('amendment-close-confirm'));
    await waitFor(() => expect(getAmendment(draft.id).negotiation_status).toBe('withdrawn_by_initiator'));
    expect(await screen.findByTestId('amendment-closed-text')).toHaveTextContent('Инициатор отозвал допсоглашение');
    expect(screen.getByTestId('amendment-status')).toHaveTextContent('Отозван инициатором');
    expect(screen.getByTestId('amendment-timeline')).toHaveTextContent('Отозвано инициатором');
  });

  it('инициатор может отозвать и после своей подписи (awaiting_signatures): подписи аннулируются', async () => {
    const draft = createAmendment(
      'rc-progress-1',
      { reason: 'Доп. этап', changes: [{ type: 'add_milestone', payload: { title: 'Плинтус', amount: '2000.00', currency: 'RUB' } }] },
      'u-1001',
    );
    sendAmendment(draft.id);
    renderAt(`/contracts/rc-progress-1/amendments/${draft.id}`);
    await userEvent.click(await screen.findByTestId('amendment-sign'));
    expect(await screen.findByText('Одна подпись есть — ждём вторую')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('amendment-withdraw'));
    await userEvent.click(screen.getByTestId('amendment-close-confirm'));
    await waitFor(() => expect(getAmendment(draft.id).negotiation_status).toBe('withdrawn_by_initiator'));
    expect(listAmendmentSignatureRequests(draft.id).every((r) => r.status !== 'pending')).toBe(true);
    expect(getAmendment(draft.id).frozen_version_id).toBeNull();
    expect(getContract('rc-progress-1').total?.amount).toBe('45000.00');
  });

  it('мок-зеркало ролей: отзыв чужого — 403 not_initiator, отклонение своего — 403 not_counterparty, повторно — 409', () => {
    expect(() => withdrawAmendment('am-seed-1', {}, 'u-1001')).toThrow(expect.objectContaining({ status: 403, code: 'not_initiator' }));
    expect(() => rejectAmendment('am-seed-1', {}, 'u-2001')).toThrow(expect.objectContaining({ status: 403, code: 'not_counterparty' }));
    expect(() => rejectAmendment('am-seed-signed-1', {}, 'u-1001')).toThrow(expect.objectContaining({ status: 409, code: 'invalid_negotiation_transition' }));
    rejectAmendment('am-seed-1', { reason: 'нет' }, 'u-1001');
    expect(() => withdrawAmendment('am-seed-1', {}, 'u-2001')).toThrow(expect.objectContaining({ status: 409 }));
  });

  it('ошибка бэка при отклонении (409) — человекочитаемый текст, допник остаётся на согласовании', async () => {
    server.use(http.post('/v1/amendments/:id/reject', () => HttpResponse.json({ status: 409, code: 'invalid_negotiation_transition', title: 'Недопустимый переход' }, { status: 409 })));
    renderAt('/contracts/rc-progress-1/amendments/am-seed-1');
    await userEvent.click(await screen.findByTestId('amendment-reject'));
    await userEvent.click(screen.getByTestId('amendment-close-confirm'));
    expect(await screen.findByTestId('amendment-error')).toHaveTextContent('В текущем статусе допсоглашения это действие недоступно');
    expect(getAmendment('am-seed-1').negotiation_status).toBe('under_review');
    server.resetHandlers();
  });

  it('несуществующий допник → ErrorState с кодом бэка', async () => {
    renderAt('/contracts/rc-progress-1/amendments/am-nope');
    expect(await screen.findByText('Не удалось загрузить допсоглашение.')).toBeInTheDocument();
    expect(screen.getByText(/not_found/)).toBeInTheDocument();
  });
});

describe('Входы на экран допсоглашения', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-person-1', kind: 'person', display_name: 'Годвин', handle: '@godwin', verification_level: 'basic', has_business_status: false },
    ]);
  });

  it('«Обзор» подписанного договора: вход «Допсоглашения (N)» ведёт на вкладку со списком (ADR-161)', async () => {
    renderAt('/contracts/rc-progress-1');
    // Вход появляется после отдельного GET /contracts/{id}/amendments — под
    // нагрузкой полного прогона (WSL) 1 с по умолчанию не хватает.
    const entry = await screen.findByTestId('open-amendments-tab', {}, { timeout: 4000 });
    // Списка допников в «Обзоре» больше нет — он живёт на своей вкладке.
    expect(screen.queryByTestId('real-amendments')).not.toBeInTheDocument();

    await userEvent.click(entry);
    const block = await screen.findByTestId('real-amendments', {}, { timeout: 4000 });
    expect(block).toHaveTextContent('Допсоглашение ждёт подписи');
    expect(within(block).getByTestId('amendments-block')).toHaveTextContent('Допсоглашение №2');
    expect(within(block).getByTestId('amendments-block')).toHaveTextContent('Подписан');

    await userEvent.click(within(block).getByRole('button', { name: /Допсоглашение №2/ }));
    expect(await screen.findByTestId('amendment-title')).toHaveTextContent('Допсоглашение №2');
  });

  it('карточка договора без допников: вход есть, но список на вкладке пуст и предлагает создать', async () => {
    renderAt('/contracts/rc-signed-cash-1');
    await screen.findByRole('tab', { name: /Обзор/ });
    await userEvent.click(await screen.findByTestId('open-amendments-tab', {}, { timeout: 4000 }));
    expect(await screen.findByTestId('amendments-block', {}, { timeout: 4000 })).toHaveTextContent('Допников пока нет');
  });

  it('разногласие со скидкой на подписи: ссылка «Подписать допсоглашение» ведёт на экран допника, не на «Историю»', async () => {
    renderAt('/disputes/dsp-discount-1');
    const link = await screen.findByTestId('dispute-pending-discount-link');
    expect(link.getAttribute('href')).toBe('/contracts/rc-progress-1/amendments/am-seed-1');
    await userEvent.click(link);
    expect(await screen.findByTestId('amendment-title')).toHaveTextContent('Допсоглашение №2');
  });
});
