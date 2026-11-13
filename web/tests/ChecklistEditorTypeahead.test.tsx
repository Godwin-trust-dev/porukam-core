import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ru } from '@porukam/i18n';
import { ChecklistEditor, type ChecklistDraftItem, type ChecklistEditorLabels } from '@porukam/ui';

/**
 * Замечание владельца 02.09: «должен быть поиск/автоподбор критериев, исходя
 * из введенного текста, а то сейчас весь перечень выходит — страшно и много».
 * Поле добавления критерия — комбобокс: пустой ввод показывает короткую
 * верхушку рекомендаций + «Показать все», набор сужает список, подсказка
 * выбирается мышью или ↑↓/Enter, свой текст по-прежнему добавляется Enter/«+».
 */

const cn = ru.contractNew;
const labels: ChecklistEditorLabels = {
  addPlaceholder: cn.checklist.addPlaceholder,
  addLabel: cn.checklist.addLabel,
  requiredLabel: cn.checklist.requiredLabel,
  emptyWarning: cn.checklist.emptyWarning,
  deleteAria: cn.checklist.deleteAria,
  suggestionsTitle: cn.checklist.suggestionsTitle,
  suggestionAddAria: cn.checklist.suggestionAddAria,
  formatShowAll: (count) => cn.checklist.showAll.replaceAll('{{count}}', String(count)),
  showLess: cn.checklist.showLess,
  noMatchHint: cn.checklist.noMatchHint,
};

const SUGGESTIONS = [
  'Плитка уложена без пустот (простукивание)',
  'Швы затёрты равномерно, зазор ≤ 2 мм',
  'Просвет под 2-метровым правилом не более 2 мм',
  'Углы и примыкания без сколов',
  'Затирка одного тона по всей площади',
  'Уклон к трапу выдержан, вода не застаивается',
  'Отверстия под сантехнику совпадают с выводами',
  'Мусор и остатки клея убраны',
];

function Harness({ suggestions = SUGGESTIONS, preview }: { suggestions?: string[]; preview?: number }): JSX.Element {
  const [items, setItems] = useState<ChecklistDraftItem[]>([]);
  return (
    <ChecklistEditor
      items={items}
      onAdd={(text) => setItems((it) => [...it, { id: `cl-${it.length + 1}`, text, requiredEvidence: true }])}
      onDelete={(id) => setItems((it) => it.filter((x) => x.id !== id))}
      labels={labels}
      suggestions={suggestions}
      suggestionsPreview={preview}
    />
  );
}

const suggestionTexts = (): string[] => screen.queryAllByTestId('checklist-suggestion').map((el) => el.textContent ?? '');
const chosenTexts = (): string[] =>
  screen.getAllByTestId(/^checklist-remove-/).map((btn) => btn.parentElement?.querySelector('span')?.textContent ?? '');

describe('ChecklistEditor — подбор критериев по вводу', () => {
  it('пустой ввод показывает только верхушку (5), не весь перечень, и «Показать все (8)»', () => {
    render(<Harness />);
    expect(suggestionTexts()).toEqual(SUGGESTIONS.slice(0, 5));
    expect(screen.getByTestId('checklist-suggestions-more')).toHaveTextContent('Показать все (8)');
    expect(screen.queryByTestId('checklist-suggestions-less')).not.toBeInTheDocument();
    expect(screen.getByTestId('checklist-add-input')).toHaveAttribute('role', 'combobox');
    expect(screen.getByTestId('checklist-add-input')).toHaveAttribute('aria-expanded', 'true');
  });

  it('«Показать все» раскрывает весь перечень, «Свернуть» возвращает верхушку', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId('checklist-suggestions-more'));
    expect(suggestionTexts()).toEqual(SUGGESTIONS);
    expect(screen.queryByTestId('checklist-suggestions-more')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('checklist-suggestions-less'));
    expect(suggestionTexts()).toEqual(SUGGESTIONS.slice(0, 5));
  });

  it('размер верхушки настраивается (suggestionsPreview)', () => {
    render(<Harness preview={3} />);
    expect(suggestionTexts()).toEqual(SUGGESTIONS.slice(0, 3));
    expect(screen.getByTestId('checklist-suggestions-more')).toHaveTextContent('Показать все (8)');
  });

  it('набор сужает список по подстроке без учёта регистра и позиции в строке', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByTestId('checklist-add-input');
    await user.type(input, 'ЗАЗОР');
    expect(suggestionTexts()).toEqual(['Швы затёрты равномерно, зазор ≤ 2 мм']);
    await user.clear(input);
    await user.type(input, '2 мм');
    expect(suggestionTexts()).toEqual(['Швы затёрты равномерно, зазор ≤ 2 мм', 'Просвет под 2-метровым правилом не более 2 мм']);
    expect(screen.queryByTestId('checklist-suggestions-more')).not.toBeInTheDocument();
  });

  it('подбор нечувствителен к диакритике — критерии на любом языке интерфейса', async () => {
    const user = userEvent.setup();
    render(<Harness suggestions={['Fliesen ohne Hohlräume verlegt', 'Fugen gleichmäßig verfüllt', 'Carreaux posés à niveau']} />);
    await user.type(screen.getByTestId('checklist-add-input'), 'hohlraume');
    expect(suggestionTexts()).toEqual(['Fliesen ohne Hohlräume verlegt']);
    await user.clear(screen.getByTestId('checklist-add-input'));
    await user.type(screen.getByTestId('checklist-add-input'), 'poses a');
    expect(suggestionTexts()).toEqual(['Carreaux posés à niveau']);
  });

  it('выбор подсказки мышью добавляет её в список, поле очищается, подсказка исчезает', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('checklist-add-input'), 'трап');
    await user.click(screen.getByTestId('checklist-suggestion'));
    expect(chosenTexts()).toEqual(['Уклон к трапу выдержан, вода не застаивается']);
    expect(screen.getByTestId('checklist-add-input')).toHaveValue('');
    // список снова показывает верхушку из оставшихся — без выбранного
    expect(suggestionTexts()).not.toContain('Уклон к трапу выдержан, вода не застаивается');
    expect(screen.getByTestId('checklist-suggestions-more')).toHaveTextContent('Показать все (7)');
  });

  it('выбор подсказки клавиатурой: ↓↓ + Enter добавляет вторую совпавшую, aria-activedescendant ведёт на неё', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByTestId('checklist-add-input');
    await user.type(input, '2 мм');
    expect(input).not.toHaveAttribute('aria-activedescendant');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options[1]!.id);
    await user.keyboard('{Enter}');
    expect(chosenTexts()).toEqual(['Просвет под 2-метровым правилом не более 2 мм']);
    expect(input).toHaveValue('');
  });

  it('↑ с ничего не выбранного уходит на последнюю подсказку, Esc снимает выделение, второй Esc очищает ввод', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByTestId('checklist-add-input');
    await user.type(input, 'мм');
    await user.keyboard('{ArrowUp}');
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options.at(-1)).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Escape}');
    expect(input).not.toHaveAttribute('aria-activedescendant');
    expect(input).toHaveValue('мм');
    await user.keyboard('{Escape}');
    expect(input).toHaveValue('');
    expect(suggestionTexts()).toEqual(SUGGESTIONS.slice(0, 5));
  });

  it('свой текст без совпадений добавляется как критерий по Enter, с подсказкой «Совпадений нет»', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByTestId('checklist-add-input');
    await user.type(input, 'Нет сколов на кромках');
    expect(screen.queryByTestId('checklist-suggestions')).not.toBeInTheDocument();
    expect(screen.getByTestId('checklist-no-match')).toHaveTextContent(cn.checklist.noMatchHint);
    await user.keyboard('{Enter}');
    expect(chosenTexts()).toEqual(['Нет сколов на кромках']);
    expect(input).toHaveValue('');
    expect(screen.queryByTestId('checklist-no-match')).not.toBeInTheDocument();
  });

  it('свой текст добавляется кнопкой «+», даже если под ним есть совпадающие подсказки', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('checklist-add-input'), 'Плитка');
    expect(suggestionTexts()).toEqual(['Плитка уложена без пустот (простукивание)']);
    await user.click(screen.getByTestId('checklist-add-submit'));
    expect(chosenTexts()).toEqual(['Плитка']);
  });

  it('набранный дословно (в другом регистре) текст рекомендации добавляется её каноническим текстом', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('checklist-add-input'), 'мусор и остатки клея убраны{enter}');
    expect(chosenTexts()).toEqual(['Мусор и остатки клея убраны']);
  });

  it('без рекомендаций — обычное поле: списка и подсказки «Совпадений нет» нет, свой текст добавляется', async () => {
    const user = userEvent.setup();
    render(<Harness suggestions={[]} />);
    expect(screen.getByTestId('checklist-add-input')).toHaveAttribute('aria-expanded', 'false');
    await user.type(screen.getByTestId('checklist-add-input'), 'Готово{enter}');
    expect(screen.queryByTestId('checklist-no-match')).not.toBeInTheDocument();
    expect(chosenTexts()).toEqual(['Готово']);
  });
});
