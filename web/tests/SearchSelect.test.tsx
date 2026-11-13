import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchSelect, type SearchSelectOption } from '@porukam/ui';

/**
 * Общий комбобокс с поиском (@porukam/ui) — замена нативному `select` с
 * крупным системным списком (замечание владельца 03.09). Один компонент на
 * каталог материалов, «Что меняем» в правке и другие длинные справочники:
 * ввод фильтрует, стрелки ходят, Enter выбирает, Esc закрывает, секции —
 * заголовками, у пункта основная строка и серая вторая.
 */

const OPTIONS: SearchSelectOption[] = [
  { value: 'method', label: 'Способ расчёта', hint: 'Наличными', group: 'Оплаты' },
  { value: 'order', label: 'Порядок оплаты', hint: 'После приёмки', group: 'Оплаты' },
  { value: 'ms-1-amount', label: 'Демонтаж · Сумма', hint: '20 000', group: 'Этапы' },
  { value: 'ms-2-amount', label: 'Укладка плитки · Сумма', hint: '60 000', group: 'Этапы' },
  { value: 'mat-1', label: 'Плитка · Количество', hint: '12', group: 'Материалы' },
  { value: 'other', label: 'Другое (своё условие)' },
];

function Harness({ options = OPTIONS, initial = '' }: { options?: SearchSelectOption[]; initial?: string }): JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <>
      <SearchSelect
        label="Что меняем"
        value={value}
        onChange={setValue}
        options={options}
        placeholder="Выберите пункт договора"
        noMatchText="Ничего не нашлось"
        data-testid="ss"
      />
      <p data-testid="value">{value}</p>
    </>
  );
}

const optionTexts = (): string[] => screen.queryAllByRole('option').map((el) => el.textContent ?? '');

describe('SearchSelect — комбобокс с поиском', () => {
  it('закрыт по умолчанию; клик открывает список со всеми пунктами', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByTestId('ss');
    expect(input).toHaveAttribute('role', 'combobox');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await user.click(input);
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(optionTexts()).toHaveLength(OPTIONS.length);
  });

  it('ввод фильтрует список без регистра, ищет и по серой строке', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByTestId('ss');
    await user.click(input);

    await user.type(input, 'сумма');
    expect(optionTexts()).toHaveLength(2);
    expect(screen.getByRole('option', { name: /Демонтаж/ })).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, 'НАЛИЧ');
    expect(optionTexts()).toHaveLength(1);
    expect(screen.getByRole('option', { name: /Способ расчёта/ })).toBeInTheDocument();
  });

  it('ничего не нашлось — текст-подсказка вместо пустого списка', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByTestId('ss');
    await user.click(input);
    await user.type(input, 'вертолет');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByTestId('ss-no-match')).toHaveTextContent('Ничего не нашлось');
  });

  it('пункты сгруппированы секциями с заголовками, у пункта серая вторая строка', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId('ss'));

    const list = screen.getByRole('listbox');
    for (const title of ['Оплаты', 'Этапы', 'Материалы']) {
      expect(within(list).getByText(title)).toBeInTheDocument();
    }
    // Заголовок секции — не выбираемый пункт.
    expect(optionTexts()).toHaveLength(OPTIONS.length);
    expect(screen.getByRole('option', { name: /Способ расчёта/ })).toHaveTextContent('Наличными');
  });

  it('клавиатура: стрелки ходят по пунктам, Enter выбирает активный', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByTestId('ss');
    await user.click(input); // фокус/клик уже открывают список

    await user.keyboard('{ArrowDown}'); // первый пункт
    await user.keyboard('{ArrowDown}'); // второй пункт
    expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[1]!.id);

    await user.keyboard('{ArrowUp}');
    expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[0]!.id);

    await user.keyboard('{Enter}');
    expect(screen.getByTestId('value')).toHaveTextContent('method');
    // Выбор закрывает список и показывает подпись выбранного пункта.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input).toHaveValue('Способ расчёта');
  });

  it('Enter без выделения выбирает единственное совпадение', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByTestId('ss');
    await user.click(input);
    await user.type(input, 'Плитка');
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('value')).toHaveTextContent('mat-1');
  });

  it('Esc закрывает список и сбрасывает набранное, значение не меняется', async () => {
    const user = userEvent.setup();
    render(<Harness initial="other" />);
    const input = screen.getByTestId('ss');
    await user.click(input);
    await user.type(input, 'сум');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByTestId('value')).toHaveTextContent('other');
    expect(input).toHaveValue('Другое (своё условие)');
  });

  it('клик по пункту выбирает его', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId('ss'));
    await user.click(screen.getByRole('option', { name: /Укладка плитки/ }));
    expect(screen.getByTestId('value')).toHaveTextContent('ms-2-amount');
  });

  it('выключенное поле не открывается', async () => {
    const user = userEvent.setup();
    render(
      <SearchSelect label="Что меняем" value="" onChange={() => {}} options={OPTIONS} disabled data-testid="ss" />,
    );
    await user.click(screen.getByTestId('ss'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
