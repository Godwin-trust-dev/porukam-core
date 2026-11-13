import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ActivityFeed,
  AttentionCard,
  ContractRow,
  EvidenceStorageCard,
  MoneyPanel,
  PeriodFilter,
} from '@porukam/ui';

describe('AttentionCard (DEV-03)', () => {
  it('рендерит сторону, срочность и вызывает onAction по клику', async () => {
    const onAction = vi.fn();
    render(
      <AttentionCard
        side="customer"
        sideLabel="Заказчик"
        urgency={{ kind: 'timer', value: '1 ч 40 мин' }}
        title="Укладка ламината, 42 м² — ждёт приёмки"
        action={{ label: 'Открыть приёмку' }}
        onAction={onAction}
      />,
    );
    expect(screen.getByText('Заказчик')).toBeInTheDocument();
    expect(screen.getByText('1 ч 40 мин')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Открыть приёмку' }));
    expect(onAction).toHaveBeenCalledOnce();
  });

  /* Замечание владельца 09.09 (скриншот витрины Google Play): строки
     «Требует внимания» были полупустыми — на телефоне заголовок прятался
     совсем (`hideTitleOnMobile`, решение 06.09), оставались чип и кнопка.
     Теперь название на телефоне ОСТАЁТСЯ, только в коротком виде
     (`shortTitle`); прежнего пропа больше нет. */
  it('строка несёт чип рода, таймер, название (полное и короткое) и кнопку', () => {
    render(
      <AttentionCard
        side="customer"
        sideLabel="Заказчик"
        kindLabel="Приёмка"
        kindTone="amber"
        urgency={{ kind: 'deadline', value: '2 д 1 ч' }}
        title="Укладка ламината, 42 м² — ждёт приёмки"
        shortTitle="Укладка ламината, 42 м²"
        action={{ label: 'Открыть приёмку', shortLabel: 'Открыть' }}
        onAction={() => {}}
      />,
    );
    expect(screen.getByText('Приёмка')).toBeInTheDocument();
    expect(screen.getByText('2 д 1 ч')).toBeInTheDocument();
    // Оба варианта названия в разметке — какой показать, решает media-запрос.
    expect(screen.getByText('Укладка ламината, 42 м² — ждёт приёмки')).toBeInTheDocument();
    expect(screen.getByText('Укладка ламината, 42 м²')).toBeInTheDocument();
    // Метка стороны — отдельным узлом ровно с текстом, разделитель рисует CSS.
    expect(screen.getByText('Заказчик')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Открыть/ })).toBeInTheDocument();
  });

  it('без shortTitle название одно — полное (карточка договора)', () => {
    render(
      <AttentionCard
        side="contractor"
        sideLabel="Исполнитель"
        title="Этап «Демонтаж» — ждёт приёмки заказчиком"
        action={{ label: 'Открыть' }}
        onAction={() => {}}
      />,
    );
    expect(screen.getByText('Этап «Демонтаж» — ждёт приёмки заказчиком')).toBeInTheDocument();
  });
});

describe('ContractRow (DEV-03) — тип оплаты, без «под защитой»', () => {
  it('рендерит тип оплаты, гейт и сумму; клик вызывает onOpen', async () => {
    const onOpen = vi.fn();
    render(
      <ContractRow
        title="Поклейка обоев, две комнаты"
        counterparty="Николай Гром (@grom_master)"
        progress={{ done: 0, total: 2 }}
        progressLabel="Этапы: 0 из 2"
        gate="Ждёт подписи"
        amount={{ amount: '28500.00', currency: 'RUB' }}
        payment="sbp"
        paymentLabel="СБП"
        onOpen={onOpen}
      />,
    );
    expect(screen.getByText('СБП')).toBeInTheDocument();
    expect(screen.getByText('Ждёт подписи')).toBeInTheDocument();
    expect(screen.queryByText(/под защитой/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button'));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

describe('PeriodFilter (DEV-03) — дефолт «месяц», roving tabindex', () => {
  const labels = { day: 'День', week: 'Неделя', month: 'Месяц', halfyear: 'Полгода' };

  it('активный таб — 0, остальные — -1; клик вызывает onChange', async () => {
    const onChange = vi.fn();
    render(<PeriodFilter value="month" onChange={onChange} labels={labels} ariaLabel="Период" />);
    expect(screen.getByTestId('period-filter-month')).toHaveAttribute('tabindex', '0');
    expect(screen.getByTestId('period-filter-day')).toHaveAttribute('tabindex', '-1');
    await userEvent.click(screen.getByTestId('period-filter-week'));
    expect(onChange).toHaveBeenCalledWith('week');
  });

  it('стрелка вправо на последнем табе переносит выбор на первый (циклично)', async () => {
    const onChange = vi.fn();
    render(<PeriodFilter value="halfyear" onChange={onChange} labels={labels} ariaLabel="Период" />);
    screen.getByTestId('period-filter-halfyear').focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('day');
  });
});

describe('MoneyPanel (DEV-03) — подписи по роли, без холда', () => {
  it('заказчик видит «Потрачено»/«Оплачено»/«К оплате»', () => {
    render(
      <MoneyPanel
        role="customer"
        earnedLabel="Потрачено за период"
        earned={{ amount: '312000.00', currency: 'RUB' }}
        donePct={52}
        donePctLabel="% выполнения"
        paidPct={61}
        paidPctLabel="% оплаты"
        receivedLabel="Оплачено"
        received={{ amount: '193000.00', currency: 'RUB' }}
        expectedLabel="К оплате"
        expected={{ amount: '119000.00', currency: 'RUB' }}
      />,
    );
    expect(screen.getByText('Потрачено за период')).toBeInTheDocument();
    expect(screen.getByText('Оплачено')).toBeInTheDocument();
    expect(screen.getByText('К оплате')).toBeInTheDocument();
    expect(screen.getByText('52%')).toBeInTheDocument();
    expect(screen.getByText('61%')).toBeInTheDocument();
  });
});

describe('ActivityFeed (DEV-03)', () => {
  it('рендерит элементы ленты и вызывает onSeeAll', async () => {
    const onSeeAll = vi.fn();
    render(
      <ActivityFeed
        title="Лента событий"
        items={[{ icon: 'checklist', text: 'Этап принят', time: '2 ч назад' }]}
        seeAllLabel="Все уведомления"
        onSeeAll={onSeeAll}
      />,
    );
    expect(screen.getByText('Этап принят')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Все уведомления' }));
    expect(onSeeAll).toHaveBeenCalledOnce();
  });
});

describe('EvidenceStorageCard (DEV-03) — только исполнитель', () => {
  it('рендерит счётчик/срок и вызывает onDownload/onExtend', async () => {
    const onDownload = vi.fn();
    const onExtend = vi.fn();
    render(
      <EvidenceStorageCard
        title="Хранение доказательств"
        countLabel="24 файла"
        daysLeftLabel="Осталось 45 дней"
        downloadLabel="Скачать"
        extendLabel="Продлить"
        onDownload={onDownload}
        onExtend={onExtend}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Скачать' }));
    await userEvent.click(screen.getByRole('button', { name: 'Продлить' }));
    expect(onDownload).toHaveBeenCalledOnce();
    expect(onExtend).toHaveBeenCalledOnce();
  });
});
