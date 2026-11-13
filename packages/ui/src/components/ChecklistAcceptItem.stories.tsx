import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ChecklistAcceptItem, type ChecklistDecision } from './ChecklistAcceptItem';

const meta: Meta<typeof ChecklistAcceptItem> = {
  title: 'Компоненты/ChecklistAcceptItem',
  component: ChecklistAcceptItem,
};
export default meta;
type Story = StoryObj<typeof ChecklistAcceptItem>;

const commonLabels = {
  acceptLabel: 'Принять',
  remarkLabel: 'Замечание',
  notePlaceholder: 'Опишите замечание',
  attachLabel: 'Приложить файл',
  groupLabel: 'Решение по пункту',
};

export const Undecided: Story = {
  args: { label: 'Ламинат уложен по всей площади', value: null, onChange: () => {}, note: '', onNoteChange: () => {}, onFileChange: () => {}, ...commonLabels },
};

export const Accepted: Story = {
  args: { label: 'Плинтус установлен', value: 'accept', onChange: () => {}, note: '', onNoteChange: () => {}, onFileChange: () => {}, ...commonLabels },
};

export const RemarkExpanded: Story = {
  render: function Render() {
    const [value, setValue] = useState<ChecklistDecision | null>('remark');
    const [note, setNote] = useState('Плинтус не закреплён в углу у окна');
    return (
      <ChecklistAcceptItem
        label="Плинтус установлен"
        value={value}
        onChange={setValue}
        note={note}
        onNoteChange={setNote}
        onFileChange={() => {}}
        attachedFileName="фото-угол.jpg"
        {...commonLabels}
      />
    );
  },
};
