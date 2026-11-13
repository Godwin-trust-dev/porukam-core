import type { Meta, StoryObj } from '@storybook/react';
import { ProfileAvatar } from './ProfileAvatar';

const meta: Meta<typeof ProfileAvatar> = {
  title: 'Компоненты/ProfileAvatar',
  component: ProfileAvatar,
};
export default meta;
type Story = StoryObj<typeof ProfileAvatar>;

export const PlaceholderFromHandle: Story = {
  name: 'Плейсхолдер от @handle',
  args: { handle: '@godwin', name: 'Godwin', size: 64 },
};

export const DifferentHandles: Story = {
  name: 'Разные хендлы — разные градиенты',
  render: () => (
    <div style={{ display: 'flex', gap: 12 }}>
      <ProfileAvatar handle="@alex" size={56} />
      <ProfileAvatar handle="@maria" size={56} />
      <ProfileAvatar handle="@teplo_remont" size={56} />
      <ProfileAvatar handle="@stroybyt" size={56} />
    </div>
  ),
};

// 1×1 GIF — демонстрирует ветку `src` без сетевого запроса и без хардкод-цвета в сторис.
const SAMPLE_IMG = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7';

export const RealImage: Story = {
  name: 'Реальное изображение (Google)',
  args: { handle: '@godwin', src: SAMPLE_IMG, size: 64, alt: 'Godwin' },
};
