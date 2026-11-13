import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { Sphere } from '@porukam/core';
import { SpherePicker } from './SpherePicker';
import { spherePickerFixtureLabels } from './__fixtures__/contractNewLabels';

const POPULAR: Sphere[] = [
  { code: 'repair', name: 'Ремонт', popular: true },
  { code: 'finishing', name: 'Отделочные работы', popular: true },
  { code: 'furniture', name: 'Сборка мебели', popular: true },
];
const ALL: Sphere[] = [...POPULAR, { code: 'moving', name: 'Переезды' }, { code: 'translation', name: 'Переводы' }];

const meta: Meta<typeof SpherePicker> = {
  title: 'Компоненты/SpherePicker',
  component: SpherePicker,
};
export default meta;
type Story = StoryObj<typeof SpherePicker>;

export const Popular: Story = {
  args: { query: '', popular: POPULAR, onQueryChange: () => {}, onPick: () => {}, ...spherePickerFixtureLabels },
};

export const EmptyResults: Story = {
  name: 'Ничего не найдено',
  args: { query: 'сноуборд', popular: POPULAR, results: [], onQueryChange: () => {}, onPick: () => {}, ...spherePickerFixtureLabels },
};

function Interactive(): JSX.Element {
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const results = query ? ALL.filter((s) => s.name.toLowerCase().includes(query.toLowerCase())) : undefined;
  return (
    <SpherePicker
      query={query}
      onQueryChange={setQuery}
      results={results}
      popular={POPULAR}
      showAll={showAll}
      onToggleShowAll={() => setShowAll((v) => !v)}
      onPick={(s) => alert(s.name)}
      {...spherePickerFixtureLabels}
    />
  );
}

export const Interactive_: Story = {
  name: 'Интерактивный',
  render: () => <Interactive />,
};
