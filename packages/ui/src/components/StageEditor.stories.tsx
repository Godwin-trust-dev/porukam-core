import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { StageEditor, type StageEditorValue } from './StageEditor';
import { stageEditorLabels } from './__fixtures__/contractNewLabels';

const meta: Meta<typeof StageEditor> = {
  title: 'Компоненты/StageEditor',
  component: StageEditor,
};
export default meta;
type Story = StoryObj<typeof StageEditor>;

const BASE: StageEditorValue = {
  title: 'Демонтаж старого гарнитура',
  amount: '20000.00',
  durationDays: '5',
  checklist: [{ id: '1', text: 'Демонтаж выполнен, мусор вывезен', requiredEvidence: true }],
  materials: [],
  advance: null,
  advancePercent: null,
};

export const Default: Story = {
  args: {
    stage: BASE,
    currency: 'RUB',
    onTitleChange: () => {},
    onAmountChange: () => {},
    onDurationChange: () => {},
    onAddChecklist: () => {},
    onDeleteChecklist: () => {},
    onOpenMaterials: () => {},
    onOpenPayment: () => {},
    labels: stageEditorLabels,
  },
};

function Interactive(): JSX.Element {
  const [stage, setStage] = useState(BASE);
  return (
    <StageEditor
      stage={stage}
      currency="RUB"
      onTitleChange={(title) => setStage((s) => ({ ...s, title }))}
      onAmountChange={(amount) => setStage((s) => ({ ...s, amount }))}
      onDurationChange={(durationDays) => setStage((s) => ({ ...s, durationDays }))}
      // Новый пункт — без требования доказательства (решение владельца 05.09);
      // у BASE признак включён — демонстрация включённого переключателя.
      onAddChecklist={(text) => setStage((s) => ({ ...s, checklist: [...s.checklist, { id: String(Math.random()), text, requiredEvidence: false }] }))}
      onDeleteChecklist={(id) => setStage((s) => ({ ...s, checklist: s.checklist.filter((c) => c.id !== id) }))}
      onToggleChecklistEvidence={(id, requiredEvidence) =>
        setStage((s) => ({ ...s, checklist: s.checklist.map((c) => (c.id === id ? { ...c, requiredEvidence } : c)) }))
      }
      onOpenMaterials={() => alert('Материалы')}
      onOpenPayment={() => alert('Оплата')}
      labels={stageEditorLabels}
    />
  );
}

export const Interactive_: Story = {
  name: 'Интерактивный',
  render: () => <Interactive />,
};
