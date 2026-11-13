import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActionMenu, ContractListRow, FilterSheet, MiniStepper, SearchInput } from '@porukam/ui';

describe('MiniStepper (DEV-13) — точки + текст, не только цвет', () => {
  it('показывает текстовую метку рядом с точками', () => {
    render(<MiniStepper done={3} total={5} label="3 из 5" />);
    expect(screen.getByText('3 из 5')).toBeInTheDocument();
  });
});

describe('ActionMenu (DEV-13 §5/§7) — desktop «⋯»', () => {
  it('открывает меню и вызывает onSelect выбранного пункта', async () => {
    const onSelect = vi.fn();
    render(
      <ActionMenu
        triggerLabel="Действия"
        items={[
          { key: 'open', label: 'Открыть', onSelect: () => {} },
          { key: 'delete', label: 'Удалить', destructive: true, onSelect },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Действия' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Удалить' }));
    expect(onSelect).toHaveBeenCalledOnce();
  });
});

describe('SearchInput (DEV-13 §4)', () => {
  it('вызывает onChange по вводу и очищает по кнопке', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<SearchInput value="" onChange={onChange} placeholder="Поиск" clearLabel="Очистить" />);
    await userEvent.type(screen.getByPlaceholderText('Поиск'), 'к');
    expect(onChange).toHaveBeenCalled();

    rerender(<SearchInput value="кухня" onChange={onChange} placeholder="Поиск" clearLabel="Очистить" />);
    await userEvent.click(screen.getByLabelText('Очистить'));
    expect(onChange).toHaveBeenCalledWith('');
  });
});

const FILTER_OPTIONS = [{ value: '', label: 'Все' }];

describe('FilterSheet (DEV-13 §4/§9) — mobile-фильтр', () => {
  it('«Сбросить» и «Выбрать» закрывают шторку сами (замечание владельца 03.09)', async () => {
    const onReset = vi.fn();
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(
      <FilterSheet
        open
        onClose={onClose}
        closeLabel="Закрыть"
        title="Фильтр"
        roleLabel="Роль"
        roleValue=""
        roleOptions={FILTER_OPTIONS}
        onRoleChange={() => {}}
        statusLabel="Статус"
        statusValue=""
        statusOptions={FILTER_OPTIONS}
        onStatusChange={() => {}}
        sphereLabel="Сфера"
        sphereValue=""
        sphereOptions={FILTER_OPTIONS}
        onSphereChange={() => {}}
        sortLabel="Сортировка"
        sortValue="updated"
        sortOptions={[{ value: 'updated', label: 'По обновлению' }]}
        onSortChange={() => {}}
        resetLabel="Сбросить"
        onReset={onReset}
        applyLabel="Выбрать"
        onApply={onApply}
      />,
    );
    await userEvent.click(screen.getByTestId('filters-apply'));
    expect(onApply).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();

    await userEvent.click(screen.getByTestId('filters-reset'));
    expect(onReset).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('ContractListRow (DEV-13 §5) — роль/статус/attention/действия/muted', () => {
  const baseProps = {
    title: 'Ремонт кухни',
    sphereLabel: 'Ремонт',
    counterpartyName: 'Мастер Ремонт',
    onOpenCounterparty: vi.fn(),
    viewerRoleLabel: 'Вы — заказчик',
    status: 'in_progress' as const,
    statusLabel: 'В работе',
    amountLabel: '120 000 ₽',
    payLabel: 'СБП',
    onOpen: vi.fn(),
    actions: [{ key: 'open', label: 'Открыть', onSelect: vi.fn() }],
    actionsTriggerLabel: 'Действия',
    actionsSheetCloseLabel: 'Закрыть',
  };

  it('клик по строке открывает договор, клик по контрагенту — не открывает договор', async () => {
    const onOpen = vi.fn();
    const onOpenCounterparty = vi.fn();
    render(<ContractListRow {...baseProps} onOpen={onOpen} onOpenCounterparty={onOpenCounterparty} />);
    await userEvent.click(screen.getByText('Мастер Ремонт'));
    expect(onOpenCounterparty).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();

    await userEvent.click(screen.getByText('Ремонт кухни'));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('attention-пилюля показывается, когда ждёт меня', () => {
    render(<ContractListRow {...baseProps} attentionLabel="Сдать этап 3" />);
    expect(screen.getByTestId('attention-pill')).toHaveTextContent('Сдать этап 3');
  });

  // DEV-20 §2: во второй строке — «контрагент · роль · этап»; точки
  // мини-степпера в 54-пиксельной строке не читались, ход работ несёт текст
  // (он же дублирует смысл не цветом — §8).
  it('этап показывается текстом только когда передан progress', () => {
    const { rerender } = render(<ContractListRow {...baseProps} />);
    expect(screen.queryByText(/2 из 5/)).not.toBeInTheDocument();
    rerender(<ContractListRow {...baseProps} progress={{ done: 2, total: 5, label: '2 из 5' }} />);
    expect(screen.getByText(/2 из 5/)).toBeInTheDocument();
  });

  // §2: номер договора в строке не показываем — он живёт в карточке.
  it('номера договора в строке нет', () => {
    render(<ContractListRow {...baseProps} title="Ремонт кухни" />);
    expect(screen.getByTestId('contract-list-row')).not.toHaveTextContent(/№|PR-/);
  });

  // §8: плотность высокая, зона нажатия — нет.
  it('строка целиком — тап-таргет', () => {
    render(<ContractListRow {...baseProps} />);
    const row = screen.getByTestId('contract-list-row');
    expect(row).toHaveAttribute('role', 'button');
    expect(row).toHaveAttribute('tabindex', '0');
  });

  // Замечание владельца 2026-09-08 («не отражается фото напротив договора»):
  // лид строки — фото контрагента, если оно у него есть и зрителю разрешено;
  // инициалы — запасной вариант, а не единственный.
  it('фото контрагента показывается аватаром-лидом, когда передан counterpartyAvatarUrl', () => {
    const { container } = render(
      <ContractListRow {...baseProps} counterpartyAvatarUrl="/v1/profiles/pf-1/avatar?size=256&v=1" />,
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', '/v1/profiles/pf-1/avatar?size=256&v=1');
    // Фото вместо инициалов, а не рядом с ними.
    expect(screen.queryByText('МР')).not.toBeInTheDocument();
  });

  it('без фото — инициалы контрагента на цветном круге', () => {
    const { container } = render(<ContractListRow {...baseProps} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('МР')).toBeInTheDocument();
  });

  it('muted — приглушённая строка для терминальных/не состоявшихся', () => {
    render(<ContractListRow {...baseProps} status="terminated_by_customer" muted />);
    expect(screen.getByTestId('contract-list-row').className).toMatch(/muted/i);
  });

  it('действия доступны через mobile-Sheet (desktop `ActionMenu` покрыт отдельным тестом)', async () => {
    const onSelect = vi.fn();
    render(<ContractListRow {...baseProps} actions={[{ key: 'archive', label: 'Экспортировать архив', onSelect }]} />);
    // Desktop-триггер скрыт CSS-брейкпоинтом в тестовом (мобильном) вьюпорте jsdom —
    // desktop-путь ActionMenu покрыт отдельным изолированным тестом выше.
    await userEvent.click(screen.getAllByLabelText('Действия', { selector: 'button' }).at(-1)!);
    await userEvent.click(screen.getByRole('button', { name: 'Экспортировать архив' }));
    expect(onSelect).toHaveBeenCalledOnce();
  });
});
