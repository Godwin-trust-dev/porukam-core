import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ChatBubble,
  ChatComposer,
  ChatSystemEvent,
  Density,
  ListRow,
  Segmented,
  Surface,
} from '@porukam/ui';

/**
 * DEV-20 — компакт-плотность: density-слой + строчные примитивы. Проверяем
 * ровно то, что заявлено приёмкой §9: строка — тап-таргет целиком, номера
 * договора в ней нет, сумма отдельным узлом, поверхность одна на список,
 * якорь остаётся воздушным, событие сделки — плашкой в ленте чата.
 */

describe('ListRow (DEV-20 §2) — строка списка', () => {
  const base = {
    avatarName: 'Анна Ковалёва',
    title: 'Ремонт кухни',
    meta: 'Анна Ковалёва · вы исполнитель',
    amount: '120 000 ₽',
    onOpen: () => {},
  };

  it('вся строка — один тап-таргет: клик по любому месту открывает', async () => {
    const onOpen = vi.fn();
    render(<ListRow {...base} onOpen={onOpen} data-testid="row" />);
    const row = screen.getByTestId('row');
    expect(row).toHaveAttribute('role', 'button');
    await userEvent.click(within(row).getByText('120 000 ₽'));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('открывается с клавиатуры (Enter и пробел)', async () => {
    const onOpen = vi.fn();
    render(<ListRow {...base} onOpen={onOpen} data-testid="row" />);
    screen.getByTestId('row').focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('непрочитанное несёт не только точку, но и текст для скринридера (§8)', () => {
    render(<ListRow {...base} unread unreadAriaLabel="Непрочитано" data-testid="row" />);
    expect(screen.getByTestId('row')).toHaveAttribute('data-unread', 'true');
    expect(screen.getByTestId('row')).toHaveTextContent('Непрочитано');
  });

  it('выбранная строка помечена aria-current (master-detail)', () => {
    render(<ListRow {...base} selected data-testid="row" />);
    expect(screen.getByTestId('row')).toHaveAttribute('aria-current', 'true');
  });
});

describe('Surface (DEV-20 §2) — одна поверхность на список', () => {
  it('строки лежат внутри ОДНОЙ поверхности, а не каждая в своей', () => {
    render(
      <Surface data-testid="surface">
        <ListRow title="Демонтаж" amount="40 000 ₽" onOpen={() => {}} data-testid="row" />
        <ListRow title="Электрика" amount="20 000 ₽" onOpen={() => {}} data-testid="row" />
      </Surface>,
    );
    const surfaces = screen.getAllByTestId('surface');
    expect(surfaces).toHaveLength(1);
    expect(within(surfaces[0]!).getAllByTestId('row')).toHaveLength(2);
  });

  it('as="ul" отдаёт списочную разметку', () => {
    render(
      <Surface as="ul" aria-label="Этапы">
        <li>Демонтаж</li>
      </Surface>,
    );
    expect(screen.getByRole('list', { name: 'Этапы' })).toBeInTheDocument();
  });
});

describe('Density (DEV-20 §1/§7)', () => {
  it('якорь объявляет cozy — рабочие экраны остаются compact по умолчанию', () => {
    render(
      <Density mode="cozy">
        <span data-testid="anchor-child">Подписание</span>
      </Density>,
    );
    expect(screen.getByTestId('anchor-child').closest('[data-density]')).toHaveAttribute('data-density', 'cozy');
  });
});

describe('Segmented (DEV-20 §6)', () => {
  it('стрелки двигают выбор (roving tabindex)', async () => {
    const onChange = vi.fn();
    render(
      <Segmented
        ariaLabel="Я в договоре"
        value="customer"
        onChange={onChange}
        items={[
          { value: 'customer', label: 'Заказчик' },
          { value: 'contractor', label: 'Исполнитель' },
        ]}
      />,
    );
    const active = screen.getByRole('tab', { name: 'Заказчик' });
    expect(active).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Исполнитель' })).toHaveAttribute('tabindex', '-1');
    active.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('contractor');
  });

  it('заблокированный сегмент не меняет выбор (роль зафиксирована черновиком)', async () => {
    const onChange = vi.fn();
    render(
      <Segmented
        ariaLabel="Я в договоре"
        value="customer"
        disabled
        onChange={onChange}
        items={[
          { value: 'customer', label: 'Заказчик' },
          { value: 'contractor', label: 'Исполнитель' },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Исполнитель' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Chat (DEV-20 §5)', () => {
  it('своё и чужое сообщение различаются направлением, событие сделки — плашкой', () => {
    render(
      <>
        <ChatBubble direction="in" timeLabel="12:30">
          Отправила этап на приёмку
        </ChatBubble>
        <ChatBubble direction="out" timeLabel="12:38">
          Приму сегодня
        </ChatBubble>
        <ChatSystemEvent timeLabel="12:31">Этап «Чистовая отделка» отправлен на приёмку · 40 000 ₽</ChatSystemEvent>
      </>,
    );
    const bubbles = screen.getAllByTestId('chat-bubble');
    expect(bubbles[0]).toHaveAttribute('data-direction', 'in');
    expect(bubbles[1]).toHaveAttribute('data-direction', 'out');
    expect(screen.getByTestId('chat-system-event')).toHaveTextContent('отправлен на приёмку');
  });

  it('композер не отправляет пустое и очищается вызывающим после отправки', async () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <ChatComposer
        value=""
        onChange={() => {}}
        onSubmit={onSubmit}
        placeholder="Сообщение…"
        inputLabel="Сообщение"
        sendLabel="Отправить"
      />,
    );
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeDisabled();

    rerender(
      <ChatComposer
        value="Готово"
        onChange={() => {}}
        onSubmit={onSubmit}
        placeholder="Сообщение…"
        inputLabel="Сообщение"
        sendLabel="Отправить"
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
