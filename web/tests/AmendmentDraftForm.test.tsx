import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { AmendmentPage } from '../src/pages/AmendmentPage';
import { ContractDetailPage } from '../src/pages/ContractDetailPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import {
  amendmentChangeForOption,
  isAmendableRef,
  splitAmendmentChanges,
} from '../src/features/contracts/amendmentChanges';
import type { RevisionItemOption } from '../src/features/contracts/contractFields';
import { listAmendments, sendAmendment } from '../src/mocks/realContractsDb';

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={createI18n('ru')}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/contracts/:id/amendments/:amendmentId" element={<AmendmentPage />} />
            <Route path="/contracts/:id" element={<ContractDetailPage />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

function signIn(): void {
  useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
  useActorStore.getState().reset();
  useActorStore.getState().setProfiles([
    { id: 'pf-person-1', kind: 'person', display_name: 'Годвин', handle: '@godwin', verification_level: 'basic', has_business_status: false },
  ]);
}

const MS = '00000000-0000-4000-8000-000000000001';

function option(over: Partial<RevisionItemOption> & { ref: string }): RevisionItemOption {
  return { label: 'x', type: 'string', choices: null, current: null, currentText: '', ...over };
}

/**
 * ADR-161 §5: словарь допника — тот же `useRevisionItemOptions`, но применимо
 * НЕ всё. Юнит-часть проверяет фильтр и упаковку значения в `payload`, чтобы
 * «поменяли сумму, а на подписи ничего не произошло» не могло повториться.
 */
describe('amendmentChanges — что допник умеет менять', () => {
  it('применимые адреса — суммы/сроки/названия этапов и количество/срок поставки материала', () => {
    expect(isAmendableRef(`milestone.${MS}.amount`)).toBe(true);
    expect(isAmendableRef(`milestone.${MS}.deadline`)).toBe(true);
    expect(isAmendableRef(`milestone.${MS}.title`)).toBe(true);
    expect(isAmendableRef(`material.${MS}.quantity`)).toBe(true);
    expect(isAmendableRef(`material.${MS}.delivery_days`)).toBe(true);
  });

  it('неприменимые адреса отфильтрованы: оплата, поля формы, условие старта, тип материала', () => {
    expect(isAmendableRef('payment.method')).toBe(false);
    expect(isAmendableRef('payment.order')).toBe(false);
    expect(isAmendableRef('title')).toBe(false);
    expect(isAmendableRef('form.address')).toBe(false);
    expect(isAmendableRef('other')).toBe(false);
    expect(isAmendableRef(`milestone.${MS}.start_gate`)).toBe(false);
    expect(isAmendableRef(`material.${MS}.type`)).toBe(false);
  });

  it('сумма этапа уходит ПАРОЙ {amount, currency} в валюте этапа', () => {
    const change = amendmentChangeForOption(option({ ref: `milestone.${MS}.amount`, type: 'decimal', currency: 'RUB' }), '40000,50');
    expect(change).toEqual({ type: 'modify_milestone', target: MS, payload: { amount: '40000.50', currency: 'RUB' } });
  });

  it('без валюты сумма не отправляется — валюты по умолчанию нет (CLAUDE.md)', () => {
    expect(amendmentChangeForOption(option({ ref: `milestone.${MS}.amount`, type: 'decimal' }), '40000')).toBeNull();
  });

  it('срок этапа — modify_milestone с ключом deadline', () => {
    expect(amendmentChangeForOption(option({ ref: `milestone.${MS}.deadline`, type: 'date' }), '2026-10-01')).toEqual({
      type: 'modify_milestone',
      target: MS,
      payload: { deadline: '2026-10-01' },
    });
  });

  it('количество материала — modify_material', () => {
    expect(amendmentChangeForOption(option({ ref: `material.${MS}.quantity`, type: 'decimal' }), '3')).toEqual({
      type: 'modify_material',
      target: MS,
      payload: { quantity: '3' },
    });
  });

  it('пустое значение строки не отправляется', () => {
    expect(amendmentChangeForOption(option({ ref: `milestone.${MS}.title`, type: 'string' }), '   ')).toBeNull();
  });

  it('разбор существующего допника: знакомое изменение — строка формы', () => {
    const { rows, passthrough } = splitAmendmentChanges([
      { type: 'modify_milestone', target: MS, payload: { amount: '40000.00', currency: 'RUB' } },
    ]);
    expect(rows).toEqual([{ key: '0-amount', ref: `milestone.${MS}.amount`, value: '40000.00' }]);
    expect(passthrough).toEqual([]);
  });

  it('незнакомое изменение уходит обратно как есть — PATCH заменяет список целиком', () => {
    // Скидка по спору (ADR-131 §3) несёт анти-waiver-оговорку в payload:
    // показать её форма не умеет, потерять при сохранении — нельзя.
    const discount = { type: 'modify_milestone', target: MS, payload: { amount: '40000.00', currency: 'RUB', anti_waiver: 'только полоса затирки' } };
    const custom = { type: 'custom_term', target: null, payload: { text: 'шум с 10 до 18' } };
    const { rows, passthrough } = splitAmendmentChanges([discount, custom]);
    expect(rows).toEqual([]);
    expect(passthrough).toEqual([discount, custom]);
  });
});

/**
 * Вкладка «Допсоглашения» и жизнь черновика поверх MSW-зеркала
 * `realContractsDb`: `rc-progress-1` — подписанный договор, Годвин
 * (`u-1001`) исполнитель; `am-seed-draft-1` — ЕГО черновик (order 3),
 * `am-seed-1` — допник контрагента на согласовании.
 */
describe('Вкладка «Допсоглашения» и черновик допника (ADR-161)', () => {
  beforeEach(signIn);

  it('у подписанного договора вкладка есть в полосе и открывается по хешу #amendments', async () => {
    renderAt('/contracts/rc-progress-1#amendments');
    expect(await screen.findByTestId('amendments-tab', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(await screen.findByTestId('real-amendments', {}, { timeout: 4000 })).toHaveTextContent('Допсоглашение №3');
  });

  it('у НЕподписанного договора вкладки нет — допник заводят только к подписанному', async () => {
    // Замечание владельца 07.09: воронки и шита у карточки нет, все вкладки
    // стоят в полосе, — «нет вкладки» проверяем прямо по полосе.
    renderAt('/contracts/rc-review-1');
    await screen.findByRole('tab', { name: /Обзор/ });
    expect(screen.queryByTestId('tab-amendments')).not.toBeInTheDocument();
    expect(screen.queryByTestId('open-filters')).not.toBeInTheDocument();
  });

  it('создание допника: причина + сумма этапа → черновик в списке', async () => {
    const before = listAmendments('rc-progress-1', 'u-1001').length;
    renderAt('/contracts/rc-progress-1#amendments');
    await userEvent.click(await screen.findByText('Создать допник', {}, { timeout: 4000 }));

    await userEvent.type(await screen.findByTestId('amendment-form-reason'), 'Добавили работы');
    await userEvent.click(screen.getByTestId('amendment-save-draft'));

    await waitFor(() => expect(listAmendments('rc-progress-1', 'u-1001')).toHaveLength(before + 1), { timeout: 4000 });
    const created = listAmendments('rc-progress-1', 'u-1001').at(-1);
    expect(created?.reason).toBe('Добавили работы');
    expect(created?.negotiation_status).toBe('draft');
  });

  it('«Отправить на согласование» из формы — создание + send одним жестом', async () => {
    renderAt('/contracts/rc-progress-1#amendments');
    await userEvent.click(await screen.findByText('Создать допник', {}, { timeout: 4000 }));
    await userEvent.type(await screen.findByTestId('amendment-form-reason'), 'Сразу на согласование');
    await userEvent.click(screen.getByTestId('amendment-save-and-send'));

    await waitFor(
      () => {
        const sent = listAmendments('rc-progress-1', 'u-1001').find((a) => a.reason === 'Сразу на согласование');
        expect(sent?.negotiation_status).toBe('under_review');
      },
      { timeout: 4000 },
    );
  });

  it('черновик инициатора: «Редактировать» меняет причину через PATCH', async () => {
    renderAt('/contracts/rc-progress-1/amendments/am-seed-draft-1');
    await userEvent.click(await screen.findByTestId('amendment-edit', {}, { timeout: 4000 }));

    const reason = await screen.findByTestId('amendment-form-reason');
    await userEvent.clear(reason);
    await userEvent.type(reason, 'Переносим срок на неделю');
    await userEvent.click(screen.getByTestId('amendment-save-draft'));

    await waitFor(
      () => {
        const draft = listAmendments('rc-progress-1', 'u-1001').find((a) => a.id === 'am-seed-draft-1');
        expect(draft?.reason).toBe('Переносим срок на неделю');
      },
      { timeout: 4000 },
    );
  });

  it('«Удалить черновик» спрашивает подтверждение и убирает допник', async () => {
    renderAt('/contracts/rc-progress-1/amendments/am-seed-draft-1');
    await userEvent.click(await screen.findByTestId('amendment-delete', {}, { timeout: 4000 }));
    await userEvent.click(await screen.findByTestId('amendment-delete-confirm'));

    await waitFor(
      () => expect(listAmendments('rc-progress-1', 'u-1001').some((a) => a.id === 'am-seed-draft-1')).toBe(false),
      { timeout: 4000 },
    );
  });

  it('после отправки правки и удаления нет — только отзыв', async () => {
    sendAmendment('am-seed-draft-1');
    renderAt('/contracts/rc-progress-1/amendments/am-seed-draft-1');
    await screen.findByTestId('amendment-title', {}, { timeout: 4000 });
    await waitFor(() => expect(screen.queryByTestId('amendment-edit')).not.toBeInTheDocument());
    expect(screen.queryByTestId('amendment-delete')).not.toBeInTheDocument();
  });

  it('чужой допник контрагента: кнопок правки черновика нет (он не черновик)', async () => {
    renderAt('/contracts/rc-progress-1/amendments/am-seed-1');
    await screen.findByTestId('amendment-title', {}, { timeout: 4000 });
    expect(screen.queryByTestId('amendment-edit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('amendment-delete')).not.toBeInTheDocument();
  });
});
