import type { Meta, StoryObj } from '@storybook/react';
import { PreviewBar } from './PreviewBar';

const meta: Meta<typeof PreviewBar> = {
  title: 'Компоненты/PreviewBar',
  component: PreviewBar,
};
export default meta;
type Story = StoryObj<typeof PreviewBar>;

export const OwnerPreview: Story = {
  args: {
    text: 'Вы смотрите свою карточку как гость',
    backLabel: 'Вернуться в профиль',
    onBack: () => {},
  },
};

/** 360px — полоса переносится в две строки, кнопка остаётся у края. */
export const Narrow: Story = {
  args: OwnerPreview.args,
  parameters: { viewport: { defaultViewport: 'mobile1' } },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 336 }}>
        <Story />
      </div>
    ),
  ],
};
