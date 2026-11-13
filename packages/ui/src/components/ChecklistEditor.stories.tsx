import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ChecklistEditor, type ChecklistDraftItem } from './ChecklistEditor';
import { checklistEditorLabels } from './__fixtures__/contractNewLabels';

const meta: Meta<typeof ChecklistEditor> = {
  title: 'Компоненты/ChecklistEditor',
  component: ChecklistEditor,
};
export default meta;
type Story = StoryObj<typeof ChecklistEditor>;

const PREFILLED: ChecklistDraftItem[] = [
  { id: '1', text: 'Плитка уложена без пустот (простукивание)', requiredEvidence: true },
  { id: '2', text: 'Швы затёрты равномерно, зазор ≤ 2 мм', requiredEvidence: true },
];

export const Prefilled: Story = {
  args: { items: PREFILLED, onAdd: () => {}, onDelete: () => {}, labels: checklistEditorLabels },
};

export const Empty: Story = {
  args: { items: [], onAdd: () => {}, onDelete: () => {}, labels: checklistEditorLabels },
};

const SUGGESTIONS = [
  'Плитка уложена без пустот (простукивание)',
  'Швы затёрты равномерно, зазор ≤ 2 мм',
  'Просвет под 2-метровым правилом не более 2 мм',
  'Углы и примыкания без сколов',
  'Затирка одного тона по всей площади',
  'Уклон к трапу выдержан, вода не застаивается',
  'Технологические отверстия под сантехнику совпадают с выводами',
  'Мусор и остатки клея убраны',
];

function Interactive({ suggestions }: { suggestions?: string[] }): JSX.Element {
  const [items, setItems] = useState<ChecklistDraftItem[]>(suggestions ? [] : PREFILLED);
  return (
    <ChecklistEditor
      items={items}
      // Новый пункт — без требования доказательства (решение владельца 05.09);
      // готовые PREFILLED оставлены с `true` — они демонстрируют включённый признак.
      onAdd={(text) => setItems((it) => [...it, { id: String(Date.now() + Math.random()), text, requiredEvidence: false }])}
      onDelete={(id) => setItems((it) => it.filter((x) => x.id !== id))}
      onToggleEvidence={(id, requiredEvidence) => setItems((it) => it.map((x) => (x.id === id ? { ...x, requiredEvidence } : x)))}
      labels={checklistEditorLabels}
      suggestions={suggestions}
    />
  );
}

export const Interactive_: Story = {
  name: 'Интерактивный',
  render: () => <Interactive />,
};

/** Отсмотр 2026-08-19: рекомендации — кликабельный список «нажми — добавится»,
 * а не предзаполнение с удалением крестиком; добавленные исчезают из списка.
 * 02.09: подбор по вводу — пустое поле показывает 5 первых + «Показать все (8)»,
 * набор («шв», «затир») сужает список; ↑↓/Enter выбирают с клавиатуры. */
export const WithSuggestions: Story = {
  name: 'С рекомендациями',
  render: () => <Interactive suggestions={SUGGESTIONS} />,
};
