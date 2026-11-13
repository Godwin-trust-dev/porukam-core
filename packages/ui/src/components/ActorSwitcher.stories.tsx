import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ActorSwitcher, type ActorSwitcherOrg } from './ActorSwitcher';

const meta: Meta<typeof ActorSwitcher> = {
  title: 'Компоненты/ActorSwitcher',
  component: ActorSwitcher,
};
export default meta;
type Story = StoryObj<typeof ActorSwitcher>;

const PERSONAL = { id: 'pf-person-1', name: 'Годвин' };
const ORGS: ActorSwitcherOrg[] = [
  { id: 'pf-biz-1', name: 'ИП Годвин · «Тёплый ремонт»', kind: 'ИП', subtitle: '@teplo_remont' },
  { id: 'pf-biz-2', name: 'СтройБыт', kind: 'ООО', subtitle: '@stroybyt' },
];

const COMMON = {
  triggerLabel: 'Сменить профиль',
  personalLabel: 'Личный',
  addOrgLabel: 'Добавить организацию',
};

export const Interactive: Story = {
  render: () => {
    function Demo(): JSX.Element {
      const [current, setCurrent] = useState('pf-person-1');
      return (
        <ActorSwitcher
          {...COMMON}
          current={current}
          personal={PERSONAL}
          orgs={ORGS}
          onSelect={setCurrent}
          onAddOrg={() => {}}
        />
      );
    }
    return <Demo />;
  },
};

export const NoOrganizations: Story = {
  args: {
    ...COMMON,
    current: 'pf-person-1',
    personal: PERSONAL,
    orgs: [],
    onSelect: () => {},
    onAddOrg: () => {},
    initialOpen: true,
  },
};

export const TwoOrganizations: Story = {
  args: {
    ...COMMON,
    current: 'pf-person-1',
    personal: PERSONAL,
    orgs: ORGS,
    onSelect: () => {},
    onAddOrg: () => {},
    initialOpen: true,
  },
};

export const ActiveOrganization: Story = {
  args: {
    ...COMMON,
    current: 'pf-biz-2',
    personal: PERSONAL,
    orgs: ORGS,
    onSelect: () => {},
    onAddOrg: () => {},
    initialOpen: true,
  },
};

const PHOTO =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="%23245c5c"/><circle cx="32" cy="24" r="12" fill="%23ffd28a"/><rect x="12" y="40" width="40" height="24" rx="12" fill="%23ffd28a"/></svg>');

export const WithPhoto: Story = {
  args: {
    ...COMMON,
    current: 'pf-person-1',
    personal: { ...PERSONAL, avatarUrl: PHOTO },
    orgs: ORGS,
    onSelect: () => {},
    onAddOrg: () => {},
    initialOpen: true,
  },
};
