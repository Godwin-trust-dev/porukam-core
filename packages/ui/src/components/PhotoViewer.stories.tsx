import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Button } from './Button';
import { PhotoViewer } from './PhotoViewer';

const meta: Meta<typeof PhotoViewer> = {
  title: 'Компоненты/PhotoViewer',
  component: PhotoViewer,
};
export default meta;
type Story = StoryObj<typeof PhotoViewer>;

export const Interactive: Story = {
  render: () => {
    function Demo(): JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Открыть просмотр фото</Button>
          <PhotoViewer open={open} name="Артём Ковалёв" onClose={() => setOpen(false)} closeLabel="Закрыть просмотр фото" />
        </>
      );
    }
    return <Demo />;
  },
};

export const OpenNoImage: Story = {
  args: { open: true, name: 'Без фото', onClose: () => {}, closeLabel: 'Закрыть' },
};
