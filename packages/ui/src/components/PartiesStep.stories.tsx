import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { HandleEntry, RevisionAuthorRole } from '@porukam/core';
import { PartiesStep } from './PartiesStep';
import { identityCardFixtureLabels, partiesStepFixtureLabels } from './__fixtures__/contractNewLabels';

const DIRECTORY: HandleEntry[] = [
  { handle: '@masterremont', display_name: 'Мастер Ремонт', kind: 'business', verification_level: 'verified' },
  { handle: '@irina_s', display_name: 'Ирина Соколова', kind: 'person', verification_level: 'basic' },
];

const VIEWER = { name: 'Годвин', maskedEmail: 'go••••n@example.com', provider: 'google' as const, verified: true, ...identityCardFixtureLabels };

const meta: Meta<typeof PartiesStep> = {
  title: 'Компоненты/PartiesStep',
  component: PartiesStep,
};
export default meta;
type Story = StoryObj<typeof PartiesStep>;

/* Пилюли роли — общий `Segmented tone="dark"` (доска B): тёмная капсула,
   выбранное — белая пилюля. Здесь видно оба состояния: обычное и `roleLocked`. */
export const RoleLocked: Story = {
  name: 'Роль зафиксирована (тёмные пилюли)',
  args: {
    role: 'contractor',
    onRoleChange: () => {},
    roleLocked: true,
    viewerIdentity: VIEWER,
    counterparty: {
      query: 'Ирина Соколова',
      selected: DIRECTORY[1] ?? null,
      onQueryChange: () => {},
      onPick: () => {},
    },
    ...partiesStepFixtureLabels,
  },
};

export const NotFoundInvite: Story = {
  name: 'Контрагент не найден → инвайт',
  args: {
    role: 'customer',
    onRoleChange: () => {},
    viewerIdentity: VIEWER,
    counterparty: { query: 'Пётр Новиков', results: [], selected: null, onQueryChange: () => {}, onPick: () => {}, onInvite: () => {} },
    paymentPolicyNote: 'Наличные и СБП, без комиссии платформы за заключение.',
    ...partiesStepFixtureLabels,
  },
};

function Interactive(): JSX.Element {
  const [role, setRole] = useState<RevisionAuthorRole>('customer');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<HandleEntry | null>(null);
  const results = query && !selected ? DIRECTORY.filter((h) => h.display_name.toLowerCase().includes(query.toLowerCase())) : undefined;
  return (
    <PartiesStep
      role={role}
      onRoleChange={setRole}
      viewerIdentity={VIEWER}
      counterparty={{
        query,
        onQueryChange: (q) => {
          setQuery(q);
          setSelected(null);
        },
        results,
        selected,
        onPick: (h) => {
          setSelected(h);
          setQuery(h.display_name);
        },
        onInvite: (name) => setSelected({ handle: '', display_name: name, kind: 'person', verification_level: 'none' }),
      }}
      paymentPolicyNote="Наличные и СБП, без комиссии платформы за заключение."
      {...partiesStepFixtureLabels}
    />
  );
}

export const Interactive_: Story = {
  name: 'Интерактивный',
  render: () => <Interactive />,
};
