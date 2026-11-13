import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { OfficialTextLine } from './OfficialTextLine';

const meta: Meta<typeof OfficialTextLine> = {
  title: 'Компоненты/OfficialTextLine',
  component: OfficialTextLine,
};
export default meta;
type Story = StoryObj<typeof OfficialTextLine>;

export const Interactive: Story = {
  render: () => {
    const [expanded, setExpanded] = useState(false);
    return (
      <OfficialTextLine
        prefix="Официальный текст — English"
        expanded={expanded}
        showLabel="Показать"
        hideLabel="Скрыть"
        onToggle={() => setExpanded((v) => !v)}
      />
    );
  },
};
