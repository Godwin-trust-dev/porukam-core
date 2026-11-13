import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { http, HttpResponse } from 'msw';
import { server } from '../src/mocks/server';
import { getMe } from '../src/mocks/profileDb';
import { DisputePage } from '../src/pages/DisputePage';
import { DisputesPage } from '../src/pages/DisputesPage';
import { DashboardPage } from '../src/pages/DashboardPage';
import { ContractDetailPage } from '../src/pages/ContractDetailPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import {
  contestWarrantyFix,
  declineWarrantyClaim,
  getDispute,
  listContractWarrantyClaims,
  satisfyWarrantyClaim,
  submitWarrantyFix,
  sweepWarrantyConfirmations,
} from '../src/mocks/disputesDb';

/**
 * Контур разногласий и гарантии (этап 7 бэкенда, ADR-131) поверх MSW-зеркала
 * `disputesDb`: карточка спора по статусам и ролям, скидка → ссылка на
 * допник, окно возражений → возражение, гарантийная претензия → разногласие.
 *
 * Сиды `disputesDb`: `dsp-open-1` (открыто, спор открыл КОНТРАГЕНТ),
 * `dsp-fix-1` (ждёт исправления), `dsp-fix-2of2` (2/2 раунда израсходованы),
 * `dsp-discount-1` (ждёт решения по скидке), `dsp-resolved-1` (закрыто),
 * `dsp-warranty-1` (гарантийное, договор rc-warranty-1).
 */
function renderAt(path: string, routes: JSX.Element) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={createI18n('ru')}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>{routes}</Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

const disputeRoute = <Route path="/disputes/:disputeId" element={<DisputePage />} />;

/**
 * Смотреть глазами ИСПОЛНИТЕЛЯ rc-warranty-1 (`pf-mock-contractor-1`) на всё
 * время теста: `useCurrentUser` синхронизирует `actorStore.profiles` с
 * `users/me` и сбрасывает чужой `activeProfileId` на персону Годвина —
 * первый GET успевал уйти как контрагент, а POST после загрузки `/me` шёл
 * уже как Годвин (403 `wrong_dispute_side`). Поэтому `/me` на время теста
 * отдаёт и профиль контрагента.
 */
function actAsContractor(): void {
  const me = getMe();
  const contractor = { id: 'pf-mock-contractor-1', kind: 'person' as const, display_name: 'Марат Отделкин', handle: '@marat', verification_level: 'basic' as const, has_business_status: false };
  server.use(http.get('/v1/users/me', () => HttpResponse.json({ ...me, profiles: [...me.profiles, contractor] })));
  useActorStore.getState().setProfiles([...me.profiles, contractor]);
  useActorStore.setState({ activeProfileId: 'pf-mock-contractor-1' });
}

describe('Карточка разногласия (этап 7, ADR-131)', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.setState({ activeProfileId: 'pf-person-1' });
  });

  it('открытое разногласие: статус, потолок, раунды и действия второй стороны', async () => {
    renderAt('/disputes/dsp-open-1', disputeRoute);

    expect(await screen.findByTestId('dispute-page')).toBeInTheDocument();
    expect(within(screen.getByTestId('dispute-status')).getByText('Открыто')).toBeInTheDocument();
    // «до потолка N дней» и «раундов осталось N из 2» — обязательная шапка.
    expect(screen.getByTestId('dispute-days-to-cap')).toHaveTextContent(/предельного срока/i);
    expect(screen.getByTestId('dispute-fix-rounds')).toHaveTextContent('2 из 2');

    // Спор открыл контрагент (u-2001), Годвин (u-1001) — вторая сторона:
    // «Ответить» ему доступно.
    expect(await screen.findByTestId('dispute-respond')).toBeInTheDocument();
    // Годвин здесь ИСПОЛНИТЕЛЬ (rc-progress-1) — раунд исправления просит
    // заказчик, поэтому кнопки нет вовсе.
    expect(screen.queryByTestId('dispute-request-fix')).not.toBeInTheDocument();
    // Закрытие по согласию и суд доступны из любого незакрытого состояния.
    expect(screen.getByTestId('dispute-resolve-accepted')).toBeInTheDocument();
    expect(screen.getByTestId('dispute-resolve-court')).toBeInTheDocument();
  });

  // DEV-20_2 §4: регламент виден ОДНОЙ строкой-заголовком, тело — по тапу.
  it('«Как решаются споры» свёрнут по умолчанию и раскрывается по тапу', async () => {
    renderAt('/disputes/dsp-open-1', disputeRoute);
    await screen.findByTestId('dispute-page');

    const block = screen.getByTestId('dispute-how');
    const trigger = within(block).getByRole('button', { name: /Как решаются споры/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // Свёрнут — тела на экране нет вовсе, а не просто спрятано стилем.
    expect(within(block).queryByText(/Платформа не решает, кто прав/)).toBeNull();

    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(within(block).getByText(/Платформа не решает, кто прав/)).toBeInTheDocument();
    // Ключевые факты регламента: два раунда, потолок 30 дней, суд.
    expect(within(block).getByText(/Два раунда исправлений/)).toBeInTheDocument();
    expect(within(block).getByText(/Предельный срок — 30 дней/)).toBeInTheDocument();
    expect(within(block).getByText(/Дальше — суд/)).toBeInTheDocument();
  });

  it('исполнителю в awaiting_fix доступна сдача исправления', async () => {
    renderAt('/disputes/dsp-fix-1', disputeRoute);
    expect(await screen.findByTestId('dispute-resubmit-fix')).toBeInTheDocument();
    expect(within(screen.getByTestId('dispute-status')).getByText('Ждёт исправления')).toBeInTheDocument();
    expect(screen.getByTestId('dispute-fix-rounds')).toHaveTextContent('1 из 2');
  });

  it('2/2: «Запросить исправление» видно заказчику, но погашено и с пояснением', async () => {
    // Смотрим глазами заказчика того же договора (rc-progress-1).
    useActorStore.setState({ activeProfileId: 'pf-mock-contractor-1' });
    renderAt('/disputes/dsp-fix-2of2', disputeRoute);

    const button = await screen.findByTestId('dispute-request-fix');
    expect(button).toBeDisabled();
    expect(screen.getByTestId('dispute-fix-rounds-exhausted')).toHaveTextContent(/Оба раунда использованы/);
    expect(screen.getByTestId('dispute-fix-rounds')).toHaveTextContent('0 из 2');
  });

  it('закрытое разногласие: панели действий нет вовсе', async () => {
    renderAt('/disputes/dsp-resolved-1', disputeRoute);
    expect(await screen.findByTestId('dispute-page')).toBeInTheDocument();
    expect(within(screen.getByTestId('dispute-status')).getByText('Закрыто')).toBeInTheDocument();
    expect(screen.queryByTestId('dispute-actions')).not.toBeInTheDocument();
    expect(screen.getByTestId('dispute-resolution')).toHaveTextContent('принято');
  });

  // Замечание владельца 05.09: «мне ответили, а я не могу посмотреть фото и
  // прочитать» — лента отдаёт текст целиком и открывает вложения.
  it('лента: комментарий стороны печатается целиком, а не припиской к дате', async () => {
    renderAt('/disputes/dsp-fix-1', disputeRoute);
    const feed = await screen.findByTestId('dispute-feed');
    const comment = within(feed).getByTestId('dispute-feed-comment');
    expect(comment).toHaveTextContent('Швы у порога разошлись — переделайте стык.');
  });

  it('лента: картинка — плиткой, тап открывает просмотрщик с оригиналом', async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => 'blob:mock');
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });

    renderAt('/disputes/dsp-open-1', disputeRoute);
    const feed = await screen.findByTestId('dispute-feed');
    const thumb = await within(feed).findByRole('button', { name: /Открыть стяжка-у-порога\.jpg/ });
    await user.click(thumb);
    expect(await screen.findByRole('dialog', { name: 'стяжка-у-порога.jpg' })).toBeInTheDocument();
    // Оригинал тянется через `GET /evidence/{id}/download` — без него владелец
    // видел бы только имя файла.
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
  });

  it('лента: не-картинка — строкой с именем файла и кнопкой «Скачать»', async () => {
    renderAt('/disputes/dsp-warranty-1', disputeRoute);
    const feed = await screen.findByTestId('dispute-feed');
    const row = await within(feed).findByTestId('dispute-feed-file');
    expect(row).toHaveTextContent('замер-влажности.pdf');
    expect(within(row).getByRole('button', { name: 'Скачать' })).toBeInTheDocument();
  });

  it('гарантийное разногласие: раундов исправления и скидки нет', async () => {
    renderAt('/disputes/dsp-warranty-1', disputeRoute);
    expect(await screen.findByTestId('dispute-page')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Гарантийное разногласие' })).toBeInTheDocument();
    expect(screen.queryByTestId('dispute-fix-rounds')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dispute-request-fix')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dispute-propose-discount')).not.toBeInTheDocument();
  });

  it('предложение скидки заканчивается ссылкой на подписание допсоглашения', async () => {
    const user = userEvent.setup();
    // Заказчик договора — ему доступна скидка по спорному листу ms-3.
    useActorStore.setState({ activeProfileId: 'pf-mock-contractor-1' });
    renderAt('/disputes/dsp-fix-2of2', disputeRoute);

    await user.click(await screen.findByTestId('dispute-propose-discount'));
    // Поле предзаполнено рекомендуемой формулировкой — своя правка заменяет её.
    await user.clear(screen.getByTestId('dispute-discount-anti-waiver'));
    await user.type(screen.getByTestId('dispute-discount-anti-waiver'), 'Только полоса затирки у окна.');
    // Сумма меньше 45000.00 RUB (ms-3) — иначе бэк ответит discount_not_applicable.
    const amount = screen.getByLabelText('Новая сумма этапа');
    await user.clear(amount);
    await user.type(amount, '40000');
    await user.click(screen.getByTestId('dispute-discount-submit'));

    const link = await screen.findByTestId('dispute-discount-amendment-link');
    expect(link).toHaveTextContent('Подписать допсоглашение');
    expect(link.getAttribute('href')).toMatch(/\/contracts\/rc-progress-1\/amendments\/am-/);
  });

  // Замечание владельца 05.09: формулировка оговорки обязательна, но
  // сочинять её человек не должен — поле открывается заполненным.
  it('оговорка об объёме предзаполнена рекомендуемой формулировкой и уходит как есть', async () => {
    const user = userEvent.setup();
    useActorStore.setState({ activeProfileId: 'pf-mock-contractor-1' });
    renderAt('/disputes/dsp-fix-2of2', disputeRoute);

    await user.click(await screen.findByTestId('dispute-propose-discount'));
    const field = screen.getByTestId('dispute-discount-anti-waiver');
    expect(field).toHaveValue('Скидка закрывает только указанный дефект и не снимает остальные требования.');
    // Подсказка теперь про «рекомендуемая», а не про «формулировка обязательна».
    expect(screen.getByText('Рекомендуемая формулировка. Можно изменить, поле обязательно.')).toBeInTheDocument();

    const amount = screen.getByLabelText('Новая сумма этапа');
    await user.clear(amount);
    await user.type(amount, '40000');
    await user.click(screen.getByTestId('dispute-discount-submit'));

    await screen.findByTestId('dispute-discount-amendment-link');
    const agreement = getDispute('dsp-fix-2of2', 'pf-mock-contractor-1').discount_agreements.at(-1);
    expect(agreement?.anti_waiver_note).toBe('Скидка закрывает только указанный дефект и не снимает остальные требования.');
  });

  it('отредактированная оговорка уходит на бэк ровно в том виде, в каком её написали', async () => {
    const user = userEvent.setup();
    useActorStore.setState({ activeProfileId: 'pf-mock-contractor-1' });
    renderAt('/disputes/dsp-fix-2of2', disputeRoute);

    await user.click(await screen.findByTestId('dispute-propose-discount'));
    const field = screen.getByTestId('dispute-discount-anti-waiver');
    await user.clear(field);
    await user.type(field, 'Скидка закрывает только полосу затирки у окна.');

    const amount = screen.getByLabelText('Новая сумма этапа');
    await user.clear(amount);
    await user.type(amount, '40000');
    await user.click(screen.getByTestId('dispute-discount-submit'));

    await screen.findByTestId('dispute-discount-amendment-link');
    const agreement = getDispute('dsp-fix-2of2', 'pf-mock-contractor-1').discount_agreements.at(-1);
    expect(agreement?.anti_waiver_note).toBe('Скидка закрывает только полосу затирки у окна.');
  });

  it('вторая сторона отклоняет предложенную скидку — спор возвращается в open', async () => {
    const user = userEvent.setup();
    renderAt('/disputes/dsp-discount-1', disputeRoute);
    await user.click(await screen.findByTestId('dispute-decline-discount'));
    await waitFor(() =>
      expect(within(screen.getByTestId('dispute-status')).getByText('Открыто')).toBeInTheDocument(),
    );
  });
});

describe('Раздел /disputes', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.setState({ activeProfileId: 'pf-person-1' });
  });

  it('список: контрагент из ответа, статус и срок до потолка', async () => {
    renderAt('/disputes', <Route path="/disputes" element={<DisputesPage />} />);
    const list = await screen.findByTestId('disputes-list');
    expect(within(list).getAllByText('Открыто').length).toBeGreaterThan(0);
    expect(within(list).getAllByText('Закрыто').length).toBeGreaterThan(0);
    // `counterparty.display_name` приходит В ОТВЕТЕ — кэш договоров не нужен.
    expect(within(list).getAllByText(/Марат Отделкин/).length).toBeGreaterThan(0);
    expect(within(list).getAllByText(/предельного срока/i).length).toBeGreaterThan(0);
  });

  it('вкладка «Гарантия» показывает претензии с переходом в разногласие', async () => {
    const user = userEvent.setup();
    renderAt('/disputes', <Route path="/disputes" element={<DisputesPage />} />);
    await screen.findByTestId('disputes-list');
    await user.click(screen.getByTestId('tab-warranty'));
    const claims = await screen.findByTestId('warranty-claims-list');
    expect(within(claims).getByText(/Ламинат у балконной двери/)).toBeInTheDocument();
    expect(within(claims).getByText('Подана')).toBeInTheDocument();
  });
});

describe('Окна возражений', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.setState({ activeProfileId: 'pf-person-1' });
  });

  it('виджет на дашборде: активное окно и возражение одним нажатием', async () => {
    const user = userEvent.setup();
    renderAt('/', <Route path="/" element={<DashboardPage />} />);

    const widget = await screen.findByTestId('dashboard-dispute-windows');
    expect(within(widget).getByText('Ответ на разногласие')).toBeInTheDocument();

    await user.click(within(widget).getByTestId('contest-window-dw-open-1'));
    await user.type(screen.getByTestId('contest-comment'), 'Работы приняты, дефекта нет.');
    await user.click(screen.getByTestId('contest-submit'));

    // Оспоренное окно закрывается — строка уходит из виджета активных.
    await waitFor(() => expect(screen.queryByTestId('contest-window-dw-open-1')).not.toBeInTheDocument());
  });

  it('окно оспаривания расторжения живёт без спора — ведёт на договор', async () => {
    renderAt('/', <Route path="/" element={<DashboardPage />} />);
    const widget = await screen.findByTestId('dashboard-dispute-windows');
    expect(within(widget).getByText('Оспаривание расторжения')).toBeInTheDocument();
    expect(within(widget).getByTestId('contest-window-dw-term-1')).toBeInTheDocument();
  });
});

describe('Гарантийная претензия', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.setState({ activeProfileId: 'pf-person-1' });
  });

  it('кнопка есть только у заказчика договора в статусе warranty', async () => {
    renderAt('/contracts/rc-warranty-1', <Route path="/contracts/:id" element={<ContractDetailPage />} />);
    expect(await screen.findByTestId('warranty-claim-open')).toBeInTheDocument();
  });

  it('в договоре без гарантийного периода кнопки нет', async () => {
    renderAt('/contracts/rc-progress-1', <Route path="/contracts/:id" element={<ContractDetailPage />} />);
    // Дожидаемся отрисовки карточки — иначе проверка «нет кнопки» пройдёт на пустом экране.
    expect(await screen.findByTestId('contract-passport')).toBeInTheDocument();
    expect(await screen.findByTestId('card-actions')).toBeInTheDocument();
    expect(screen.queryByTestId('warranty-claim-open')).not.toBeInTheDocument();
  });

  it('претензия без доказательства не отправляется', async () => {
    const user = userEvent.setup();
    renderAt('/contracts/rc-warranty-1', <Route path="/contracts/:id" element={<ContractDetailPage />} />);
    await user.click(await screen.findByTestId('warranty-claim-open'));
    await user.type(screen.getByTestId('warranty-claim-description'), 'Ламинат вздулся у порога.');
    // `evidence` с `allow_empty=False` на бэке — кнопка не даёт уйти в 422.
    expect(screen.getByTestId('warranty-claim-submit')).toBeDisabled();
  });

  it('претензия с доказательством открывает разногласие', async () => {
    const user = userEvent.setup();
    renderAt(
      '/contracts/rc-warranty-1',
      <>
        <Route path="/contracts/:id" element={<ContractDetailPage />} />
        {disputeRoute}
      </>,
    );

    await user.click(await screen.findByTestId('warranty-claim-open'));
    await user.type(screen.getByTestId('warranty-claim-description'), 'Ламинат вздулся у порога.');
    await user.upload(
      screen.getByLabelText('Выбрать файлы'),
      new File(['photo-bytes'], 'defect.jpg', { type: 'image/jpeg' }),
    );
    await waitFor(() => expect(screen.getByTestId('warranty-claim-evidence')).toHaveTextContent('defect.jpg'));

    await user.click(screen.getByTestId('warranty-claim-submit'));
    // Успех уводит в открытое претензией разногласие (`dispute_id`).
    expect(await screen.findByRole('heading', { name: 'Гарантийное разногласие' })).toBeInTheDocument();
  });
});

/**
 * Контур устранения по гарантийной претензии (ADR-133): подтверждает
 * ЗАКАЗЧИК, симметрично отказу исполнителя; исполнитель «устранил» → окно
 * подтверждения → «удовлетворена» / «не устранено» (раунды как в споре) →
 * молчание = автоподтверждение по свипу.
 *
 * Сиды: `dsp-warranty-1`/`wc-1` (подана, Годвин `pf-person-1` — ЗАКАЗЧИК
 * rc-warranty-1, исполнитель — `pf-mock-contractor-1`), `dsp-warranty-fix-1`/
 * `wc-2` (исполнитель уже сообщил «устранил», окно `dw-warranty-fix-1` тикает).
 */
describe('Гарантийная претензия — устранение и подтверждение (ADR-133)', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.setState({ activeProfileId: 'pf-person-1' });
  });

  it('исполнителю по поданной претензии доступны «Сообщить об устранении» и «Отказать»; общего «Закрыть по согласию» нет', async () => {
    actAsContractor();
    renderAt('/disputes/dsp-warranty-1', disputeRoute);
    expect(await screen.findByTestId('warranty-fix-submitted')).toBeEnabled();
    expect(screen.getByTestId('warranty-decline')).toBeInTheDocument();
    expect(screen.queryByTestId('warranty-satisfy')).not.toBeInTheDocument();
    expect(screen.queryByTestId('warranty-contest')).not.toBeInTheDocument();
    expect(screen.queryByTestId('warranty-confirm-callout')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dispute-resolve-accepted')).not.toBeInTheDocument();
    expect(screen.getByTestId('dispute-resolve-court')).toBeInTheDocument();
    expect(screen.getByTestId('warranty-fix-rounds')).toHaveTextContent('2 из 2');
    // Описание претензии — первой строкой ленты.
    expect(screen.getByTestId('dispute-feed')).toHaveTextContent('Ламинат у балконной двери');
  });

  it('заказчику по поданной претензии: кнопок исполнителя нет, «Удовлетворена» есть (сделали на месте), «Не устранено» — нет', async () => {
    renderAt('/disputes/dsp-warranty-1', disputeRoute);
    expect(await screen.findByTestId('dispute-page')).toBeInTheDocument();
    expect(await screen.findByTestId('warranty-satisfy')).toBeInTheDocument();
    expect(screen.queryByTestId('warranty-fix-submitted')).not.toBeInTheDocument();
    expect(screen.queryByTestId('warranty-decline')).not.toBeInTheDocument();
    expect(screen.queryByTestId('warranty-contest')).not.toBeInTheDocument();
  });

  it('исполнитель сообщает об устранении → «ждёт подтверждения заказчика», окно и раунд в ленте', async () => {
    const user = userEvent.setup();
    actAsContractor();
    renderAt('/disputes/dsp-warranty-1', disputeRoute);
    await user.click(await screen.findByTestId('warranty-fix-submitted'));
    await user.type(screen.getByTestId('warranty-fix-comment'), 'Ламинат перестелили, стык закрыт.');
    await user.click(screen.getByTestId('warranty-fix-submitted-submit'));

    expect(await screen.findByTestId('warranty-confirm-callout')).toHaveTextContent('Заказчик подтвердит устранение или возразит');
    expect(screen.getByTestId('warranty-confirm-callout')).toHaveTextContent('претензия закроется автоматически');
    expect(screen.getByTestId('warranty-claim-status')).toHaveTextContent('Ждёт подтверждения заказчика');
    // Сдача исполнителя раунд НЕ тратит — потолок на возражения заказчика.
    expect(screen.getByTestId('warranty-fix-rounds')).toHaveTextContent('2 из 2');
    expect(screen.getByTestId('dispute-feed')).toHaveTextContent('Исполнитель сообщил об устранении — раунд 1');
    expect(screen.getByTestId('dispute-feed')).toHaveTextContent('Ламинат перестелили');
    // Исполнителю сдавать больше нечего — ждёт заказчика; отказ остаётся.
    expect(screen.queryByTestId('warranty-fix-submitted')).not.toBeInTheDocument();
    expect(screen.getByTestId('warranty-decline')).toBeInTheDocument();
    const claim = listContractWarrantyClaims('rc-warranty-1').find((c) => c.id === 'wc-1');
    expect(claim?.status).toBe('awaiting_confirmation');
    expect(claim?.acceptance_deadline_at).toBeTruthy();
    expect(claim?.fixes?.[0]?.round).toBe(1);
  });

  it('заказчик видит таймер «Подтвердить устранение — осталось … до …» и кнопки «Удовлетворена» / «Не устранено»', async () => {
    renderAt('/disputes/dsp-warranty-fix-1', disputeRoute);
    const callout = await screen.findByTestId('warranty-confirm-callout');
    expect(callout).toHaveTextContent(/Подтвердить устранение — осталось .+ · до/);
    expect(callout).toHaveTextContent('Если не ответить — претензия закроется автоматически');
    expect(await screen.findByTestId('warranty-satisfy')).toBeInTheDocument();
    expect(screen.getByTestId('warranty-contest')).toBeEnabled();
    expect(screen.queryByTestId('warranty-fix-submitted')).not.toBeInTheDocument();
    expect(screen.queryByTestId('warranty-decline')).not.toBeInTheDocument();
  });

  it('заказчик подтверждает устранение → претензия и спор закрыты «претензия удовлетворена»', async () => {
    const user = userEvent.setup();
    renderAt('/disputes/dsp-warranty-fix-1', disputeRoute);
    await user.click(await screen.findByTestId('warranty-satisfy'));
    await user.click(screen.getByTestId('warranty-satisfy-confirm'));
    await waitFor(() => expect(within(screen.getByTestId('dispute-status')).getByText('Закрыто')).toBeInTheDocument());
    expect(screen.getByTestId('dispute-resolution')).toHaveTextContent('претензия удовлетворена');
    expect(screen.getByTestId('dispute-feed')).toHaveTextContent('Претензия удовлетворена — устранение подтверждено');
    expect(screen.queryByTestId('dispute-actions')).not.toBeInTheDocument();
    const claim = listContractWarrantyClaims('rc-warranty-1').find((c) => c.id === 'wc-2');
    expect(claim?.status).toBe('resolved');
    expect(claim?.resolution_type).toBe('warranty_satisfied');
    expect(claim?.acceptance_deadline_at).toBeNull();
  });

  it('заказчик может подтвердить и по поданной претензии без «устранил» (сделали на месте)', async () => {
    const user = userEvent.setup();
    renderAt('/disputes/dsp-warranty-1', disputeRoute);
    await user.click(await screen.findByTestId('warranty-satisfy'));
    await user.click(screen.getByTestId('warranty-satisfy-confirm'));
    await waitFor(() => expect(within(screen.getByTestId('dispute-status')).getByText('Закрыто')).toBeInTheDocument());
    expect(screen.getByTestId('dispute-resolution')).toHaveTextContent('претензия удовлетворена');
  });

  it('заказчик: «Не устранено» требует комментарий → претензия снова у исполнителя, окно закрыто как оспоренное', async () => {
    const user = userEvent.setup();
    renderAt('/disputes/dsp-warranty-fix-1', disputeRoute);
    await user.click(await screen.findByTestId('warranty-contest'));
    expect(screen.getByTestId('warranty-contest-submit')).toBeDisabled();
    await user.type(screen.getByTestId('warranty-contest-comment'), 'Плинтус у двери всё ещё отходит.');
    await user.click(screen.getByTestId('warranty-contest-submit'));

    await waitFor(() => expect(screen.queryByTestId('warranty-confirm-callout')).not.toBeInTheDocument());
    expect(screen.getByTestId('dispute-feed')).toHaveTextContent('Заказчик: не устранено — раунд 1');
    expect(screen.getByTestId('dispute-feed')).toHaveTextContent('Плинтус у двери всё ещё отходит');
    // Возражение — раунд: осталось одно.
    expect(screen.getByTestId('warranty-fix-rounds')).toHaveTextContent('1 из 2');
    const claim = listContractWarrantyClaims('rc-warranty-1').find((c) => c.id === 'wc-2');
    expect(claim?.status).toBe('submitted');
    expect(claim?.fix_rounds_used).toBe(1);
    expect(claim?.acceptance_deadline_at).toBeNull();
    expect(claim?.fixes?.[0]?.contested_at).toBeTruthy();
  });

  it('исполнитель отказывает по претензии → «претензия отклонена»', async () => {
    const user = userEvent.setup();
    actAsContractor();
    renderAt('/disputes/dsp-warranty-1', disputeRoute);
    await user.click(await screen.findByTestId('warranty-decline'));
    await user.type(screen.getByTestId('warranty-decline-comment'), 'Дефект от затопления соседями, не гарантийный.');
    await user.click(screen.getByTestId('warranty-decline-submit'));
    await waitFor(() => expect(within(screen.getByTestId('dispute-status')).getByText('Закрыто')).toBeInTheDocument());
    expect(screen.getByTestId('dispute-resolution')).toHaveTextContent('претензия отклонена');
    expect(screen.getByTestId('dispute-feed')).toHaveTextContent('Исполнитель отказал по претензии');
    expect(listContractWarrantyClaims('rc-warranty-1').find((c) => c.id === 'wc-1')?.resolution_type).toBe('warranty_declined');
  });

  it('молчание заказчика: свип закрывает претензию автоматически исходом «претензия удовлетворена»', async () => {
    const closed = sweepWarrantyConfirmations(new Date(Date.now() + 30 * 24 * 3600 * 1000));
    expect(closed.map((c) => c.id)).toEqual(['wc-2']);
    renderAt('/disputes/dsp-warranty-fix-1', disputeRoute);
    // Признака «авто» в сериализаторе заявки нет — исход тот же, что у ручного подтверждения.
    expect(await screen.findByTestId('dispute-resolution')).toHaveTextContent('претензия удовлетворена');
    expect(screen.queryByTestId('warranty-confirm-callout')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dispute-actions')).not.toBeInTheDocument();
  });

  it('возражения ограничены: третье «не устранено» — 409 fix_rounds_exhausted, кнопка гаснет с пояснением; сдачи исполнителя потолка не имеют', async () => {
    submitWarrantyFix('wc-1', 'pf-mock-contractor-1', { comment: 'раз', evidence: [] });
    contestWarrantyFix('wc-1', 'pf-person-1', { comment: 'нет', evidence: [] });
    submitWarrantyFix('wc-1', 'pf-mock-contractor-1', { comment: 'два', evidence: [] });
    contestWarrantyFix('wc-1', 'pf-person-1', { comment: 'опять нет', evidence: [] });
    submitWarrantyFix('wc-1', 'pf-mock-contractor-1', { comment: 'три', evidence: [] });
    expect(() => contestWarrantyFix('wc-1', 'pf-person-1', { comment: 'и снова нет', evidence: [] })).toThrow(
      expect.objectContaining({ status: 409, code: 'fix_rounds_exhausted' }),
    );
    renderAt('/disputes/dsp-warranty-1', disputeRoute);
    expect(await screen.findByTestId('warranty-contest')).toBeDisabled();
    expect(screen.getByTestId('warranty-rounds-exhausted')).toHaveTextContent('Оба возражения «не устранено» использованы');
    expect(screen.getByTestId('warranty-fix-rounds')).toHaveTextContent('0 из 2');
    expect(screen.getByTestId('warranty-satisfy')).toBeEnabled();
  });

  it('мок-зеркало ролей и состояний: чужая сторона — 403 wrong_dispute_side, вне окна — 409, закрытая — 409 warranty_claim_already_resolved', () => {
    expect(() => submitWarrantyFix('wc-1', 'pf-person-1', { comment: '', evidence: [] })).toThrow(expect.objectContaining({ status: 403, code: 'wrong_dispute_side' }));
    expect(() => declineWarrantyClaim('wc-1', 'pf-person-1', { comment: '' })).toThrow(expect.objectContaining({ status: 403, code: 'wrong_dispute_side' }));
    expect(() => satisfyWarrantyClaim('wc-2', 'pf-mock-contractor-1')).toThrow(expect.objectContaining({ status: 403, code: 'wrong_dispute_side' }));
    expect(() => contestWarrantyFix('wc-2', 'pf-mock-contractor-1', { comment: 'x', evidence: [] })).toThrow(expect.objectContaining({ status: 403, code: 'wrong_dispute_side' }));
    // Возражать нечему, пока исполнитель не сообщил об устранении; повторный «устранил» — пока окно идёт.
    expect(() => contestWarrantyFix('wc-1', 'pf-person-1', { comment: 'x', evidence: [] })).toThrow(expect.objectContaining({ status: 409, code: 'warranty_claim_not_awaiting_confirmation' }));
    expect(() => submitWarrantyFix('wc-2', 'pf-mock-contractor-1', { comment: '', evidence: [] })).toThrow(expect.objectContaining({ status: 409, code: 'warranty_claim_awaiting_confirmation' }));
    satisfyWarrantyClaim('wc-2', 'pf-person-1');
    expect(() => contestWarrantyFix('wc-2', 'pf-person-1', { comment: 'x', evidence: [] })).toThrow(expect.objectContaining({ status: 409, code: 'warranty_claim_already_resolved' }));
  });

  it('ошибка бэка при подтверждении — человекочитаемый текст по коду', async () => {
    const user = userEvent.setup();
    server.use(http.post('/v1/warranty-claims/:id/satisfy', () => HttpResponse.json({ status: 409, code: 'warranty_claim_already_resolved', title: 'x' }, { status: 409 })));
    renderAt('/disputes/dsp-warranty-fix-1', disputeRoute);
    await user.click(await screen.findByTestId('warranty-satisfy'));
    await user.click(screen.getByTestId('warranty-satisfy-confirm'));
    expect(await screen.findByTestId('warranty-action-error')).toHaveTextContent('Гарантийная претензия уже закрыта');
    server.resetHandlers();
  });

  it('виджет окон на дашборде: окно подтверждения устранения (из претензий, не из /dispute-windows) с пометкой об автозакрытии; «Не устранено» одним нажатием', async () => {
    const user = userEvent.setup();
    renderAt('/', <Route path="/" element={<DashboardPage />} />);
    const widget = await screen.findByTestId('dashboard-dispute-windows');
    expect(await within(widget).findByText('Подтверждение устранения по гарантии')).toBeInTheDocument();
    expect(within(widget).getByTestId('window-auto-note-wc-2')).toHaveTextContent('претензия закроется автоматически');

    await user.click(within(widget).getByTestId('contest-claim-wc-2'));
    expect(screen.getByTestId('contest-submit')).toBeDisabled();
    await user.type(screen.getByTestId('contest-comment'), 'Стык снова разошёлся.');
    await user.click(screen.getByTestId('contest-submit'));
    await waitFor(() => expect(screen.queryByTestId('contest-claim-wc-2')).not.toBeInTheDocument());
    expect(listContractWarrantyClaims('rc-warranty-1').find((c) => c.id === 'wc-2')?.status).toBe('submitted');
  });

  it('вкладка «Гарантия» показывает состояние «Ждёт подтверждения заказчика»', async () => {
    const user = userEvent.setup();
    renderAt('/disputes', <Route path="/disputes" element={<DisputesPage />} />);
    await screen.findByTestId('disputes-list');
    await user.click(screen.getByTestId('tab-warranty'));
    const claims = await screen.findByTestId('warranty-claims-list');
    expect(within(claims).getByText('Ждёт подтверждения заказчика')).toBeInTheDocument();
  });
});

describe('Реплики сторон на карточке спора', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.setState({ activeProfileId: 'pf-person-1' });
  });

  it('ответ второй стороны — строкой с текстом в ленте (replies), а не только «следами»', async () => {
    const user = userEvent.setup();
    renderAt('/disputes/dsp-open-1', disputeRoute);
    await user.click(await screen.findByTestId('dispute-respond'));
    await user.type(screen.getByTestId('dispute-respond-comment'), 'Стяжку принимали по акту, трещин не было.');
    await user.click(screen.getByTestId('dispute-respond-submit'));
    await waitFor(() => expect(screen.getByTestId('dispute-feed')).toHaveTextContent('Ответ стороны'));
    expect(screen.getByTestId('dispute-feed')).toHaveTextContent('Стяжку принимали по акту');
    expect(getDispute('dsp-open-1', 'pf-person-1').replies?.[0]?.author_id).toBe('u-1001');
  });
});
