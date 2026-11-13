import type { Meta, StoryObj } from '@storybook/react';
import { PortfolioTile } from './PortfolioTile';

const meta: Meta<typeof PortfolioTile> = {
  title: 'Компоненты/PortfolioTile',
  component: PortfolioTile,
};
export default meta;
type Story = StoryObj<typeof PortfolioTile>;

export const Grid: Story = {
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 140px)', gap: 12 }}>
      <PortfolioTile status="confirmed" statusLabel="Подтверждено" />
      <PortfolioTile status="claimed" statusLabel="Заявлено" />
      <PortfolioTile status="confirmed" statusLabel="Подтверждено" onClick={() => alert('Заглушка — карточка проекта')} />
    </div>
  ),
};
