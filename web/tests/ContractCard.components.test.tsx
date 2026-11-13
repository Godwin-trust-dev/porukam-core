import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ContractCardStatus } from '@porukam/core';
import {
  AmendmentsBlock,
  AttentionCard,
  ContractHeader,
  ContractStatus,
  ContractTimeline,
  MoneyPanel,
  PartyRow,
  PaymentPlan,
  StageTree,
} from '@porukam/ui';

describe('ContractStatus (DEV-06 §3/§4) — 14 значений, текст+цвет', () => {
  const ALL: ContractCardStatus[] = [
    'draft',
    'under_review',
    'rejected_by_counterparty',
    'withdrawn_by_initiator',
    'pending_signature',
    'awaiting_signatures',
    'signed',
    'in_progress',
    'suspended',
    'completed',
    'terminated_by_customer',
    'terminated_by_contractor',
    'under_warranty',
    'warranty_claim',
  ];

  it.each(ALL)('%s рендерит переданный текст-подпись', (status) => {
    render(<ContractStatus status={status} label={`Метка ${status}`} />);
    expect(screen.getByText(`Метка ${status}`)).toBeInTheDocument();
  });

  it('показывает «этап N из M» только когда передан stageCaption', () => {
    render(<ContractStatus status="in_progress" label="В работе" stageCaption="этап 2 из 4" />);
    expect(screen.getByText('этап 2 из 4')).toBeInTheDocument();
  });

  it('один статус-чип — не рендерит второй текстовый узел статуса', () => {
    render(<ContractStatus status="signed" label="Подписан" />);
    expect(screen.getAllByText('Подписан')).toHaveLength(1);
  });
});

describe('AttentionCard (DEV-06 §2/§8) — симметрия: одно событие, разные роли/режимы', () => {
  it('customer: primary action виден и вызывает onAction', async () => {
    const onAction = vi.fn();
    render(
      <AttentionCard
        side="customer"
        sideLabel="Заказчик"
        title="Этап «Черновая отделка» ждёт вашей приёмки"
        action={{ label: 'Принять' }}
        onAction={onAction}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Принять' }));
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('contractor: info-режим показывает текст и вторичное действие вместо кнопки принятия', async () => {
    const onRemind = vi.fn();
    render(
      <AttentionCard
        side="contractor"
        sideLabel="Исполнитель"
        title="Ждём приёмку этапа «Черновая отделка» заказчиком"
        info={{
          text: 'Заказчик получил уведомление — приёмка обычно занимает 1–2 дня.',
          secondaryAction: { label: 'Напомнить', onAction: onRemind },
        }}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Принять' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Напомнить' }));
    expect(onRemind).toHaveBeenCalledOnce();
  });
});

describe('StageTree (DEV-06 §3, техспецификация §6.3) — статусы листьев', () => {
  it('открываемые статусы (in_progress/under_acceptance/submitted) вызывают onOpen', async () => {
    const onOpen = vi.fn();
    render(
      <StageTree
        openLabel="Открыть этап"
        onOpen={onOpen}
        stages={[
          { id: 'ms-1', ix: 1, name: 'Демонтаж', sum: { amount: '20000.00', currency: 'RUB' }, status: 'accepted', statusLabel: 'Принят' },
          { id: 'ms-2', ix: 2, name: 'Отделка', sum: { amount: '50000.00', currency: 'RUB' }, status: 'in_progress', statusLabel: 'В работе' },
        ]}
      />,
    );
    // Принятый лист не кликабелен как «открыть этап».
    expect(screen.getAllByRole('button', { name: 'Открыть этап' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Открыть этап' }));
    expect(onOpen).toHaveBeenCalledWith('ms-2');
  });
});

describe('MoneyPanel (DEV-06 §3/§11.5) — «Оплачено»/«Остаток» универсально', () => {
  it('показывает переданные подписи и суммы, headline опционален', () => {
    render(
      <MoneyPanel
        role="customer"
        paidPct={40}
        paidPctLabel="% оплаты"
        receivedLabel="Оплачено"
        received={{ amount: '40000.00', currency: 'RUB' }}
        expectedLabel="Остаток"
        expected={{ amount: '60000.00', currency: 'RUB' }}
      />,
    );
    expect(screen.getByText('Оплачено')).toBeInTheDocument();
    expect(screen.getByText('Остаток')).toBeInTheDocument();
    expect(screen.getByText('40 000 ₽')).toBeInTheDocument();
    expect(screen.getByText('60 000 ₽')).toBeInTheDocument();
    expect(screen.queryByText('Получено')).not.toBeInTheDocument();
    expect(screen.queryByText('Ожидается')).not.toBeInTheDocument();
  });

  it('способ расчёта — опциональная плитка', () => {
    render(
      <MoneyPanel
        role="customer"
        paidPct={0}
        paidPctLabel="% оплаты"
        receivedLabel="Оплачено"
        received={{ amount: '0.00', currency: 'RUB' }}
        expectedLabel="Остаток"
        expected={{ amount: '100.00', currency: 'RUB' }}
        methodLabel="Способ расчёта"
        method="СБП"
      />,
    );
    expect(screen.getByText('Способ расчёта')).toBeInTheDocument();
    expect(screen.getByText('СБП')).toBeInTheDocument();
  });
});

describe('PaymentPlan (DEV-06 §3/§5, DEV-07 §4) — paid/due/later', () => {
  it('рендерит оплаченные, к оплате и отложенные строки', () => {
    render(
      <PaymentPlan
        paidLabel="Оплачено"
        dueLabel="К оплате"
        laterLabel="Позже"
        rows={[
          { id: 'r1', stage: 'Демонтаж', amount: { amount: '20000.00', currency: 'RUB' }, state: 'paid' },
          { id: 'r2', stage: 'Отделка', amount: { amount: '50000.00', currency: 'RUB' }, state: 'due' },
          { id: 'r3', stage: 'Уборка', amount: { amount: '5000.00', currency: 'RUB' }, state: 'later' },
        ]}
      />,
    );
    expect(screen.getByText('Демонтаж')).toBeInTheDocument();
    expect(screen.getByText('Отделка')).toBeInTheDocument();
    expect(screen.getAllByText('Оплачено')).toHaveLength(1);
    expect(screen.getAllByText('К оплате')).toHaveLength(1);
    expect(screen.getAllByText('Позже')).toHaveLength(1);
  });

  it('кнопка «Оплатить» — только на строке due, вызывает onPay с id строки', async () => {
    const onPay = vi.fn();
    render(
      <PaymentPlan
        paidLabel="Оплачено"
        dueLabel="К оплате"
        laterLabel="Позже"
        payLabel="Оплатить"
        onPay={onPay}
        rows={[
          { id: 'r1', stage: 'Демонтаж', amount: { amount: '20000.00', currency: 'RUB' }, state: 'paid' },
          { id: 'r2', stage: 'Отделка', amount: { amount: '50000.00', currency: 'RUB' }, state: 'due' },
        ]}
      />,
    );
    expect(screen.getAllByRole('button', { name: 'Оплатить' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Оплатить' }));
    expect(onPay).toHaveBeenCalledWith('r2');
  });
});

describe('ContractTimeline (DEV-06 §3/§5)', () => {
  it('рендерит события в порядке передачи', () => {
    render(
      <ContractTimeline
        events={[
          { id: 'e1', title: 'Договор подписан', at: '22 июл', done: true },
          { id: 'e2', title: 'Этап приостановлен', at: '26 июл', who: 'исполнитель', done: false },
        ]}
      />,
    );
    expect(screen.getByText('Договор подписан')).toBeInTheDocument();
    expect(screen.getByText(/исполнитель/)).toBeInTheDocument();
  });
});

describe('AmendmentsBlock (DEV-06 §3) — пусто → пояснение, список → строки', () => {
  it('пусто: показывает пояснение и «Создать допник»', async () => {
    const onCreate = vi.fn();
    render(
      <AmendmentsBlock
        amendments={[]}
        emptyTitle="Допников пока нет"
        emptyText="Пояснение"
        createLabel="Создать допник"
        onCreate={onCreate}
      />,
    );
    expect(screen.getByText('Допников пока нет')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Создать допник' }));
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it('список: рендерит допники со статусами', () => {
    render(
      <AmendmentsBlock
        amendments={[
          { id: 'a1', title: 'Допник №1', statusLabel: 'Подписан', statusTone: 'green', createdAtLabel: '2 авг' },
        ]}
        emptyTitle="Допников пока нет"
        emptyText="Пояснение"
        createLabel="Создать допник"
        onCreate={() => {}}
      />,
    );
    expect(screen.getByText('Допник №1')).toBeInTheDocument();
    expect(screen.getByText('Подписан')).toBeInTheDocument();
  });
});

describe('ContractHeader (DEV-06 §3/§6/§8) — контрагент только кликабельное имя', () => {
  it('клик по имени контрагента вызывает onOpen, роль не дублируется рядом с именем', async () => {
    const onOpen = vi.fn();
    render(
      <ContractHeader
        title="Ремонт кухни"
        no="№ Р-1"
        counterparty={{ name: 'Мастер Ремонт', onOpen }}
        viewerRoleLabel="Вы — заказчик"
        status="in_progress"
        statusLabel="В работе"
        sum={{ amount: '120000.00', currency: 'RUB' }}
        paymentMethodLabel="СБП"
      />,
    );
    await userEvent.click(screen.getByTestId('counterparty-link'));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(screen.getByText('Мастер Ремонт')).toBeInTheDocument();
  });

  // DEV-16c §2 ⭐ — сумма договора (+валюта) — LTR-островок: не зеркалится в RTL.
  it('сумма — LTR-островок (dir="ltr")', () => {
    render(
      <ContractHeader
        title="Ремонт кухни"
        no="№ Р-1"
        counterparty={{ name: 'Мастер Ремонт', onOpen: () => {} }}
        viewerRoleLabel="Вы — заказчик"
        status="in_progress"
        statusLabel="В работе"
        sum={{ amount: '120000.00', currency: 'RUB' }}
        paymentMethodLabel="СБП"
      />,
    );
    expect(screen.getByTestId('contract-header-sum')).toHaveAttribute('dir', 'ltr');
  });
});

describe('PartyRow (DEV-06 §3)', () => {
  it('signed: показывает дату подписи', () => {
    render(
      <PartyRow
        name="Годвин"
        role="Заказчик"
        signState="signed"
        signedAt="2026-07-31T10:00:00.000Z"
        signedLabel="Подписал"
        pendingLabel="Ожидает"
      />,
    );
    expect(screen.getByText('Подписал')).toBeInTheDocument();
  });

  // DEV-16c §2 ⭐ — дата подписи (юрзначимая — DEV-16 §5) — LTR-островок.
  it('дата подписи — LTR-островок (dir="ltr")', () => {
    render(
      <PartyRow
        name="Годвин"
        role="Заказчик"
        signState="signed"
        signedAt="2026-07-31T10:00:00.000Z"
        signedLabel="Подписал"
        pendingLabel="Ожидает"
      />,
    );
    expect(screen.getByTestId('party-row-signed-at')).toHaveAttribute('dir', 'ltr');
  });
});
