import type { Meta, StoryObj } from '@storybook/react';
import { Button } from './Button';
import { GoogleButton } from './GoogleButton';

const meta: Meta<typeof GoogleButton> = {
  title: 'Компоненты/GoogleButton',
  component: GoogleButton,
};
export default meta;
type Story = StoryObj<typeof GoogleButton>;

export const Default: Story = {
  args: { label: 'Continue with Google', onClick: () => {} },
};

export const Loading: Story = {
  args: { label: 'Continue with Google', onClick: () => {}, loading: true },
};

export const Disabled: Story = {
  args: { label: 'Continue with Google', onClick: () => {}, disabled: true },
};

/**
 * Пара кнопок экрана входа (замечание владельца 08.09 «хочется единый стиль
 * страницы»): «Продолжить через Google» — это `Button variant="outline" block`
 * с марко́й в `leftIcon`, поэтому шрифт, вес, кегль, высота, рамка, радиус и
 * фон у обеих кнопок обязаны совпадать. Если история начнёт показывать две
 * разные кнопки — унификация разъехалась.
 */
export const РядомСВходомПоПочте: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--pr-sp-4)', maxWidth: 288 }}>
      <GoogleButton label="Продолжить через Google" onClick={() => {}} />
      <Button variant="outline" block>
        Войти по почте
      </Button>
    </div>
  ),
};
