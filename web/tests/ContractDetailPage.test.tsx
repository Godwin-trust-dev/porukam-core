import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { ContractDetailPage } from '../src/pages/ContractDetailPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { createContract, createMilestone, listChecklistItems } from '../src/mocks/realContractsDb';
import { WIDTH_WIDE, setViewportWidth } from './viewport';

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
            <Route path="/chat/:contractId" element={<div data-testid="chat-stub">chat</div>} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

/**
 * ADR-088, Фаза 1 — реальный контур сделки (id-префикс `rc-`, диспетчер в
 * ContractDetailPage.tsx). `realContractsDb.ts`: rc-draft-1 (черновик, без
 * этапов), rc-review-1 (под согласованием, дерево из 2 листьев = 25000 RUB,
 * 1 критерий приёмки на ms-1). `pf-person-1` — заказчик в обоих.
 */
/**
 * Вкладки карточки сделки (замечание владельца 07.09): воронки и шита у
 * карточки больше нет — ВСЕ вкладки стоят в полосе (на телефоне в несколько
 * рядов), поэтому путь человека — прямой клик по вкладке.
 */
async function openCardTab(value: string): Promise<void> {
  await userEvent.click(await screen.findByTestId(`tab-${value}`));
}

describe('ContractDetailPage — реальный контур (ADR-088, Фаза 1)', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-person-1', kind: 'person', display_name: 'Годвин', handle: '@godwin', verification_level: 'basic', has_business_status: false },
    ]);
  });

  it('черновик: вид собран из отдельных реальных вызовов, «Отправить» переводит в under_review', async () => {
    renderPage('/contracts/rc-draft-1');
    expect(await screen.findByText('Ремонт крана на кухне')).toBeInTheDocument();
    // Резолвится отдельным GET /profiles/{id} — контрагент rc-draft-1 — Марат Отделкин.
    expect(await screen.findByText((t) => t.includes('Марат Отделкин'))).toBeInTheDocument();
    expect(screen.getByText('Сумма не задана')).toBeInTheDocument(); // total=null — этапов ещё нет (Фаза 0 ADR-088)

    await userEvent.click(screen.getByTestId('send-contract'));
    expect(await screen.findByText('На согласовании')).toBeInTheDocument();
  });

  it('под согласованием: этапы собраны из GET /contracts/{id}/milestones — дерево, не мок-агрегат', async () => {
    renderPage('/contracts/rc-review-1');
    await screen.findByText('Сборка мебели — гостиная');
    await userEvent.click(screen.getByRole('tab', { name: /Этапы/ }));

    expect(await screen.findByDisplayValue('Шкаф-купе')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Стеллаж')).toBeInTheDocument();
    expect(screen.getByText('нужно доказательство')).toBeInTheDocument(); // checklist item, ms-1
  });

  it('вкладка «Условия»: вторая сторона видит все поля формы человеческими словами (отсмотр 24.08)', async () => {
    renderPage('/contracts/rc-review-1');
    await screen.findByText('Сборка мебели — гостиная');
    // Доска B «Условия»: вкладка → свёрнутые юр-блоки → тёмная «Смотреть все
    // условия» раскрывает полный список полей на месте.
    await userEvent.click(screen.getByRole('tab', { name: /Условия/ }));
    const panel = await screen.findByTestId('real-terms-panel');
    await userEvent.click(screen.getByTestId('see-all-terms'));
    expect(panel).toHaveTextContent('Наличный расчёт');
    expect(panel).toHaveTextContent('25 000');
    const fields = screen.getByTestId('real-terms-fields');
    expect(fields).toHaveTextContent('Собрать шкаф-купе и стеллаж по чертежам заказчика, вынести упаковку.');
    expect(screen.getByTestId('real-terms-location_type')).toHaveTextContent('На месте');
    expect(screen.getByTestId('real-terms-subcontract_policy')).toHaveTextContent('Запрещён');
    expect(screen.getByTestId('real-terms-access_required')).toHaveTextContent('Да');
    // Служебные ключи не показываются как поля.
    expect(screen.queryByTestId('real-terms-sphere_code')).not.toBeInTheDocument();
    // Подсказка о статусе: условия на согласовании, правки — во вкладке переговоров.
    expect(panel).toHaveTextContent('Условия на согласовании');
  });

  it('«Переговоры и подписи» — только чтение (Фаза 3–4 не тронуты)', async () => {
    renderPage('/contracts/rc-review-1');
    await screen.findByText('Сборка мебели — гостиная');
    await openCardTab('negoSign');
    expect(await screen.findByText('Открытых правок нет.')).toBeInTheDocument();
    expect(screen.getByText('Запросов на подпись пока нет.')).toBeInTheDocument();
  });

  /**
   * Замечание владельца 03.09: «пропала кнопка редактирования в договоре …
   * „предложить правку“ надо продублировать в „обзор“ сразу под „Перейти к
   * подписанию“, иначе не найдут».
   */
  it('обзор: «Предложить правку» стоит вторым действием под primary и открывает окно правки', async () => {
    renderPage('/contracts/rc-review-1');
    await screen.findByText('Сборка мебели — гостиная');
    const actions = await screen.findByTestId('card-actions');
    // Primary — «Перейти к подписанию», сразу под ним дублирующая правка.
    expect(within(actions).getByTestId('go-to-signing-screen')).toBeInTheDocument();
    const propose = within(actions).getByTestId('overview-propose-revision');
    expect(propose).toHaveTextContent('Предложить правку');
    await userEvent.click(propose);
    // Уводит на вкладку согласования и сразу открывает то же окно, что ghost-кнопка.
    expect(await screen.findByTestId('real-propose-revision')).toBeInTheDocument();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('обзор: правка недопустима вне согласования — дубля кнопки нет (черновик)', async () => {
    renderPage('/contracts/rc-draft-1');
    await screen.findByText('Ремонт крана на кухне');
    expect(screen.queryByTestId('overview-propose-revision')).not.toBeInTheDocument();
  });

  it('«Заказчик» может отозвать rc-review-1 (он — инициатор) — через подтверждение', async () => {
    renderPage('/contracts/rc-review-1');
    await screen.findByText('Сборка мебели — гостиная');
    await userEvent.click(await screen.findByTestId('withdraw-contract'));
    // ADR-124: жест деструктивный (из заморозки ещё и аннулирует раунд) — спрашиваем.
    expect(await screen.findByText('Отозвать договор?')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('close-contract-confirm'));
    expect(await screen.findByText('Отозван инициатором')).toBeInTheDocument();
  });

  // ADR-124: бэк разрешает reject/withdraw и из pending_signature /
  // awaiting_signatures — карточка обязана давать те же две кнопки, иначе из
  // заморозки выйти можно только с экрана подписания.
  it('ADR-124: инициатор отзывает договор из pending_signature (rc-frozen-1)', async () => {
    renderPage('/contracts/rc-frozen-1');
    await screen.findByText('Установка окон');
    expect(await screen.findByText('Версия заморожена')).toBeInTheDocument();
    await userEvent.click(await screen.findByTestId('withdraw-contract'));
    expect(await screen.findByText('Отозвать договор?')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('close-contract-confirm'));
    expect(await screen.findByText('Отозван инициатором')).toBeInTheDocument();
  });

  it('ADR-124: вторая сторона отклоняет договор из awaiting_signatures (rc-awaiting-my-turn-1)', async () => {
    // Инициатор rc-awaiting-my-turn-1 — заказчик; смотрим глазами исполнителя.
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-mock-contractor-1', kind: 'person', display_name: 'Марат Отделкин', handle: '@marat_otdelkin', verification_level: 'basic', has_business_status: false },
    ]);
    renderPage('/contracts/rc-awaiting-my-turn-1');
    await screen.findByText('Поклейка обоев');
    // Не инициатор — «Отозвать» ему не показываем, только «Отклонить».
    expect(await screen.findByTestId('reject-contract')).toBeInTheDocument();
    expect(screen.queryByTestId('withdraw-contract')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('reject-contract'));
    expect(await screen.findByText('Отклонить договор?')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('close-contract-confirm'));
    expect(await screen.findByText('Отклонён контрагентом')).toBeInTheDocument();
  });

  it('ADR-124: подписанный договор из карточки уже не отозвать и не отклонить', async () => {
    renderPage('/contracts/rc-signed-review-1');
    await screen.findByText('Поклейка обоев в спальне');
    expect(screen.queryByTestId('withdraw-contract')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reject-contract')).not.toBeInTheDocument();
  });

  it('после заморозки лист на вкладке «Этапы» ведёт на страницу этапа (дашбордная доводка)', async () => {
    renderPage('/contracts/rc-frozen-1');
    await screen.findByText('Установка окон');
    await userEvent.click(screen.getByRole('tab', { name: /Этапы/ }));

    const open = await screen.findByTestId('open-stage'); // единственный лист ms-5
    await userEvent.click(open);
    expect(await screen.findByTestId('stage-stub')).toBeInTheDocument();
  });

  it('в редактируемом состоянии (under_review) кнопки «Открыть этап» нет', async () => {
    renderPage('/contracts/rc-review-1');
    await screen.findByText('Сборка мебели — гостиная');
    await userEvent.click(screen.getByRole('tab', { name: /Этапы/ }));

    expect(await screen.findByDisplayValue('Шкаф-купе')).toBeInTheDocument();
    expect(screen.queryByTestId('open-stage')).not.toBeInTheDocument();
  });

  it('кнопка «Чат» в паспорте ведёт в переписку по договору /chat/{id} (ADR-112/116)', async () => {
    renderPage('/contracts/rc-draft-1');
    await screen.findByText('Ремонт крана на кухне');
    await userEvent.click(screen.getByTestId('open-chat'));
    expect(await screen.findByTestId('chat-stub')).toBeInTheDocument();
  });

  it('порядок вкладок «Этапы» → «Оплаты» → «Чат», чат ведёт в /chat/{id}', async () => {
    renderPage('/contracts/rc-review-1');
    await screen.findByText('Сборка мебели — гостиная');
    const tabs = screen.getAllByRole('tab').map((el) => el.textContent ?? '');
    // Отсмотр 2026-08-25: «Оплаты» встали между «Этапами» и «Чатом» — деньги
    // ближе к дереву этапов. Замечание владельца 07.09: все вкладки стоят в
    // полосе (на телефоне в несколько рядов), но порядок важности прежний.
    const stagesIdx = tabs.findIndex((name) => name.startsWith('Этапы'));
    expect(stagesIdx).toBeGreaterThan(-1);
    expect(tabs[stagesIdx + 1]).toMatch(/^Оплаты/);
    expect(tabs[stagesIdx + 2]).toMatch(/^Чат/);

    await openCardTab('chat');
    expect(await screen.findByText('Чат по договору')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('chat-tab-open'));
    expect(await screen.findByTestId('chat-stub')).toBeInTheDocument();
  });

  it('обзор: клик по этапу в сводке ведёт на экран этапа', async () => {
    // Доска B: сводка этапов в обзоре — у подписанного договора (в работе);
    // на согласовании обзор — стороны и сумма, этапы живут на своей вкладке.
    renderPage('/contracts/rc-progress-1');
    await screen.findByText('Ремонт ванной комнаты');
    // Отсмотр 2026-08-25: перечень этапов внизу обзора был не кликабельным.
    await userEvent.click(await screen.findByRole('button', { name: /Плитка/ }));
    expect(await screen.findByTestId('stage-stub')).toBeInTheDocument();
  });

  /**
   * Э5, ADR-130: строка вкладки — это СЧЁТ (`GET /contracts/{id}/payments`),
   * а не денежный лист. Сид rc-paying-1: ms-pay-1 — просроченный `pending`,
   * ms-pay-2 — `confirmed`, ms-pay-4 — отмечен плательщиком, ms-pay-5 —
   * отменён; у ms-pay-3 (`in_progress`) счёта нет вовсе. Годвин —
   * ЗАКАЗЧИК, то есть ПЛАТЕЛЬЩИК (`my_side: payer`).
   */
  it('вкладка «Оплаты»: строки — счета, а не листья; статусы и просрочка', async () => {
    renderPage('/contracts/rc-paying-1');
    await screen.findByText('Ремонт балкона');
    await userEvent.click(screen.getByRole('tab', { name: /^Оплаты/ }));

    const rows = await screen.findAllByTestId('payment-row');
    // 4 счёта на 5 денежных листьев: у листа в работе постоплату ещё не
    // выставляли — предлагать подтвердить нечего.
    expect(rows).toHaveLength(4);
    expect(screen.queryByText('Уборка')).not.toBeInTheDocument();

    expect(screen.getByText('Не оплачено')).toBeInTheDocument();
    expect(screen.getByText('Оплачено')).toBeInTheDocument();
    expect(screen.getByText('Отмечено плательщиком')).toBeInTheDocument();
    expect(screen.getByText('Отменён')).toBeInTheDocument();
    // Просрочка — не статус: счёт остаётся `pending`, рядом красный бейдж.
    expect(screen.getByText('Просрочено 3 дн.')).toBeInTheDocument();
    expect(screen.getByText('Причина: Счёт выставлен на неверную сумму')).toBeInTheDocument();

    // Итог считается по ЖИВЫМ счетам: отменённые 3 000 ₽ в «Всего» не входят.
    const sum = screen.getByTestId('payments-sum');
    expect(sum).toHaveTextContent(/33\s?000/);
    expect(sum).toHaveTextContent(/8\s?000/);
  });

  it('вкладка «Оплаты», плательщик: «Я оплатил» → статус меняется, CTA гаснет', async () => {
    renderPage('/contracts/rc-paying-1');
    await screen.findByText('Ремонт балкона');
    await userEvent.click(screen.getByRole('tab', { name: /^Оплаты/ }));

    // Кнопка ровно одна: на `pending`-счёте. На счёте, уже отмеченном мной
    // (ms-pay-4), — подсказка «ждём вторую сторону», а не вторая кнопка.
    const confirm = await screen.findAllByTestId('payment-confirm');
    expect(confirm).toHaveLength(1);
    expect(confirm[0]!).toHaveTextContent('Я оплатил');
    expect(screen.getByText(/Ждём подтверждения второй стороны/)).toBeInTheDocument();

    await userEvent.click(confirm[0]!);

    await waitFor(() => expect(screen.getAllByText('Отмечено плательщиком')).toHaveLength(2));
    expect(screen.queryByTestId('payment-confirm')).not.toBeInTheDocument();
    // Отмена возможна только из `pending` — после отметки её тоже нет.
    expect(screen.queryByTestId('payment-cancel')).not.toBeInTheDocument();
  });

  it('вкладка «Оплаты», получатель: CTA — «Подтвердить получение» на обоих неподтверждённых счетах', async () => {
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-mock-contractor-1', kind: 'person', display_name: 'Марат Отделкин', handle: '@marat_otdelkin', verification_level: 'basic', has_business_status: false },
    ]);
    renderPage('/contracts/rc-paying-1');
    await screen.findByText('Ремонт балкона');
    await userEvent.click(screen.getByRole('tab', { name: /^Оплаты/ }));

    const confirm = await screen.findAllByTestId('payment-confirm');
    // `pending` и `payer_confirmed` — обе ждут ЕГО подтверждения.
    expect(confirm).toHaveLength(2);
    expect(confirm[0]!).toHaveTextContent('Подтвердить получение');
    // Он ничего не отмечал — подсказки «ждём вторую сторону» у него нет.
    expect(screen.queryByText(/Ждём подтверждения второй стороны/)).not.toBeInTheDocument();

    // Второе подтверждение на `payer_confirmed` закрывает счёт.
    await userEvent.click(confirm[1]!);
    await waitFor(() => expect(screen.getAllByText('Оплачено')).toHaveLength(2));
  });

  it('вкладка «Оплаты»: отмена счёта с причиной — только из «не оплачено»', async () => {
    renderPage('/contracts/rc-paying-1');
    await screen.findByText('Ремонт балкона');
    await userEvent.click(screen.getByRole('tab', { name: /^Оплаты/ }));

    // Отменяемый счёт ровно один — тот, что в `pending`.
    const cancel = await screen.findAllByTestId('payment-cancel');
    expect(cancel).toHaveLength(1);
    await userEvent.click(cancel[0]!);

    await userEvent.type(screen.getByTestId('payment-cancel-reason'), 'Ошиблись реквизитами');
    await userEvent.click(screen.getByTestId('payment-cancel-submit'));

    await waitFor(() => expect(screen.getAllByText('Отменён')).toHaveLength(2));
    expect(screen.getByText('Причина: Ошиблись реквизитами')).toBeInTheDocument();
    expect(screen.queryByTestId('payment-confirm')).not.toBeInTheDocument();
  });

  it('вкладка «Оплаты», direct_platform: счетов нет вовсе — вместо строк пояснение', async () => {
    renderPage('/contracts/rc-progress-1');
    await screen.findByText('Ремонт ванной комнаты');
    await userEvent.click(screen.getByRole('tab', { name: /^Оплаты/ }));

    // ADR-130: `direct_platform`/`hold` требуют платёжного партнёра — бэк по
    // таким договорам счетов не выставляет вовсе (а попытка выставить
    // отвечает 409 `payment_provider_not_configured`), поэтому список пуст.
    // Пустое место читалось бы как поломка — вместо кнопок стоит пояснение.
    expect(await screen.findByTestId('platform-payment-notice')).toBeInTheDocument();
    expect(screen.getByText('Оплата через платформу пока недоступна')).toBeInTheDocument();
    expect(screen.queryByTestId('payment-row')).not.toBeInTheDocument();
    expect(screen.queryByTestId('payment-confirm')).not.toBeInTheDocument();
  });

  it('вкладка «Оплаты»: «Открыть этап» ведёт на экран этапа', async () => {
    renderPage('/contracts/rc-paying-1');
    await screen.findByText('Ремонт балкона');
    await userEvent.click(screen.getByRole('tab', { name: /^Оплаты/ }));

    const open = await screen.findAllByTestId('payment-open-stage');
    await userEvent.click(open[0]!);
    expect(await screen.findByTestId('stage-stub')).toBeInTheDocument();
  });

  it('старый мок-агрегат (не rc-*) продолжает работать через LegacyContractDetail', async () => {
    renderPage('/contracts/c-3001');
    // Легаси-страница показывает свой собственный переключатель «Смотреть как» — маркер того,
    // что диспетчер ушёл в старую ветку, не в реальную.
    expect(await screen.findByTestId('viewas-customer')).toBeInTheDocument();
  });

  it('легаси-ветка: добавления критериев приёмки нет — мёртвый путь удалён (хвосты 25.08)', async () => {
    // Легаси-POST шёл на вложенный `/contracts/{id}/milestones/{msId}/checklist-items`
    // с телом `{ text }`; такого маршрута на бэке нет, а в не-мок-режиме легаси-ветка
    // вообще не монтируется (`isRealContractId` всегда true). Путь удалён; добавление
    // критериев осталось только в реальной ветке.
    renderPage('/contracts/c-3001');
    await screen.findByTestId('viewas-customer');
    await userEvent.click(screen.getByRole('tab', { name: /^Этапы/ }));

    // Этапы легаси-агрегата отрисованы (ветка жива), но кнопки добавления критериев нет.
    expect(await screen.findByDisplayValue('Сборка каркаса')).toBeInTheDocument();
    expect(screen.queryByTestId('checklist-add-open')).not.toBeInTheDocument();
  });
});

/**
 * Отсмотр 2026-08-25 («создаю договор аренды: после создания одного критерия
 * другие уже не пропускает, не сохраняет»). Аренда шага «Этапы» в мастере не
 * имеет (stepsFor — только услуга), критерии добавляются на вкладке «Этапы»
 * карточки договора. Мутация пункта чек-листа сбрасывала только дерево
 * (`['real-milestones']`), а список пунктов живёт под своим ключом
 * (`['real-checklist-items', milestoneId]`) — после первого добавления он
 * оставался в кэше устаревшим: пункт не появлялся («не сохраняет»), а
 * следующий уходил с тем же `order` (base считается по устаревшему списку).
 */
describe('Карточка договора аренды — критерии приёмки добавляются подряд', () => {
  function seedRentContract(): { contractId: string; milestoneId: string } {
    const contract = createContract({
      client_option: 'rent',
      contract_type_code: 'rent_items',
      my_role: 'customer',
      my_acting_as: 'person',
      payment_method: 'cash',
      title: 'Аренда генератора',
    });
    const milestone = createMilestone(contract.id, { title: 'Передача имущества', amount: '5000', currency: 'RUB' });
    return { contractId: contract.id, milestoneId: milestone.id };
  }

  async function addCriterion(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
    await user.click(screen.getByTestId('checklist-add-open'));
    await user.type(await screen.findByTestId('checklist-add-input'), `${text}{enter}`);
    await user.click(screen.getByTestId('checklist-add-save'));
  }

  it('три критерия подряд: каждый сразу виден в списке этапа и сохраняется со своим order', async () => {
    const user = userEvent.setup();
    const { contractId, milestoneId } = seedRentContract();
    renderPage(`/contracts/${contractId}`);
    await screen.findByText('Аренда генератора');
    await user.click(screen.getByRole('tab', { name: /Этапы/ }));
    await screen.findByDisplayValue('Передача имущества');

    const texts = ['Имущество передано в исправном состоянии', 'Составлен акт приёма-передачи', 'Показания счётчиков зафиксированы'];
    for (const [i, text] of texts.entries()) {
      await addCriterion(user, text);
      // Список пунктов перерисовывается сразу — раньше он оставался устаревшим.
      expect(await screen.findByText(text)).toBeInTheDocument();
      await waitFor(() => expect(listChecklistItems(milestoneId)).toHaveLength(i + 1));
    }

    const items = listChecklistItems(milestoneId);
    expect(items.map((it) => it.description)).toEqual(texts);
    expect(items.map((it) => it.order)).toEqual([0, 1, 2]); // order не залипает на 0
  });
});

/**
 * Замечание владельца 07.09: сперва про десктоп («скрыты поля Чат и Переговоры
 * и подписи. это очень не удобно»), затем про телефон («в самой сделке фильтр
 * мы плохо придумали для навигации на мобильном устройстве… Люди не могут
 * найти»). Итог один на обе раскладки: полоса вкладок карточки показывает ВСЕ
 * вкладки и воронки не имеет; на узком экране они переносятся в 2–3 ряда.
 * Воронка остаётся в списках сделок — там за ней фильтры, а не вкладки.
 */
describe('Вкладки карточки сделки — все в полосе (замечание владельца 07.09)', () => {
  let restore: () => void = () => {};

  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-person-1', kind: 'person', display_name: 'Годвин', handle: '@godwin', verification_level: 'basic', has_business_status: false },
    ]);
  });

  afterEach(() => {
    restore();
    restore = () => {};
  });

  it('⭐ ≥1024: все вкладки стоят в ряд, воронки и шита нет', async () => {
    restore = setViewportWidth(WIDTH_WIDE);
    renderPage('/contracts/rc-review-1');
    await screen.findByText('Сборка мебели — гостиная');

    // Раньше в ряду стояли только четыре первые, остальные — за воронкой.
    for (const key of ['overview', 'terms', 'stages', 'payments', 'chat', 'negoSign', 'timeline']) {
      expect(screen.getByTestId(`tab-${key}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId('open-filters')).not.toBeInTheDocument();

    // Вкладка открывается прямым кликом, без прохода через шит.
    await userEvent.click(screen.getByTestId('tab-negoSign'));
    expect(await screen.findByText('Открытых правок нет.')).toBeInTheDocument();
  });

  it('⭐ <1024: на телефоне тоже ВСЕ вкладки — в несколько рядов, без воронки', async () => {
    // Замечание владельца 07.09 (мобильный): «в самой сделке фильтр мы плохо
    // придумали для навигации… люди не могут найти». Воронки и шита у карточки
    // нет ни на одной раскладке; ряды переносятся средствами CSS (`showAll`).
    renderPage('/contracts/rc-review-1');
    await screen.findByText('Сборка мебели — гостиная');

    for (const key of ['overview', 'terms', 'stages', 'payments', 'chat', 'negoSign', 'timeline']) {
      expect(screen.getByTestId(`tab-${key}`)).toBeInTheDocument();
    }
    expect(screen.getAllByRole('tab')).toHaveLength(7);
    expect(screen.queryByTestId('open-filters')).not.toBeInTheDocument();

    // Спрятанная прежде вкладка открывается прямым кликом.
    await userEvent.click(screen.getByTestId('tab-negoSign'));
    expect(await screen.findByText('Открытых правок нет.')).toBeInTheDocument();
  });
});
