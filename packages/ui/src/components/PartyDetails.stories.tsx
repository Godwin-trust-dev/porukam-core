import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { PartyDetails, type PartyDetailsMode } from './PartyDetails';
import { partyDetailsFixtureLabels } from './__fixtures__/contractNewLabels';

const meta: Meta<typeof PartyDetails> = {
  title: 'Компоненты/PartyDetails',
  component: PartyDetails,
};
export default meta;
type Story = StoryObj<typeof PartyDetails>;

export const Collapsed: Story = {
  args: { open: false, mode: 'personal', fields: {}, onToggleOpen: () => {}, onModeChange: () => {}, onFieldChange: () => {}, ...partyDetailsFixtureLabels },
};

export const Business: Story = {
  args: {
    open: true,
    mode: 'business',
    fields: { org_name: 'ИП Годвин' },
    onToggleOpen: () => {},
    onModeChange: () => {},
    onFieldChange: () => {},
    ...partyDetailsFixtureLabels,
  },
};

function Interactive(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<PartyDetailsMode>('personal');
  const [fields, setFields] = useState<Record<string, string>>({});
  return (
    <PartyDetails
      open={open}
      onToggleOpen={setOpen}
      mode={mode}
      onModeChange={setMode}
      fields={fields}
      onFieldChange={(k, v) => setFields((f) => ({ ...f, [k]: v }))}
      {...partyDetailsFixtureLabels}
    />
  );
}

export const Interactive_: Story = {
  name: 'Интерактивный',
  render: () => <Interactive />,
};
