import type { Meta, StoryObj } from '@storybook/react';
import { Icon } from './Icon';
import { ICON_NAMES } from '../icons/paths';

const meta: Meta<typeof Icon> = {
  title: 'Основы/Иконки',
  component: Icon,
};
export default meta;
type Story = StoryObj<typeof Icon>;

export const AllIcons: Story = {
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(120px,1fr))', gap: 12 }}>
      {ICON_NAMES.map((name) => (
        <div
          key={name}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
            padding: 14,
            border: '1px solid var(--pr-line)',
            borderRadius: 'var(--pr-r-md)',
            background: 'var(--pr-white)',
            color: 'var(--pr-ink)',
          }}
        >
          <Icon name={name} size={32} />
          <code style={{ fontSize: 11, color: 'var(--pr-text-2)' }}>{name}</code>
        </div>
      ))}
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 24, alignItems: 'flex-end', color: 'var(--pr-ink)' }}>
      {[16, 20, 24, 32, 48].map((s) => (
        <div key={s} style={{ textAlign: 'center' }}>
          <Icon name="shield" size={s as 16 | 20 | 24 | 32 | 48} />
          <div style={{ fontSize: 11, color: 'var(--pr-text-2)' }}>{s}px</div>
        </div>
      ))}
    </div>
  ),
};

export const OnDark: Story = {
  parameters: { backgrounds: { default: 'ink (dark UI)' } },
  render: () => (
    <div style={{ display: 'flex', gap: 18, color: 'var(--pr-icon-on-dark)' }}>
      <Icon name="sealed" size={32} />
      <Icon name="shield" size={32} />
      <Icon name="contract" size={32} />
      <Icon name="reputation" size={32} />
    </div>
  ),
};
