import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { OfficialTextView } from './OfficialTextView';
import { Button } from './Button';

const meta: Meta<typeof OfficialTextView> = {
  title: 'Компоненты/OfficialTextView',
  component: OfficialTextView,
};
export default meta;
type Story = StoryObj<typeof OfficialTextView>;

/**
 * DEV-16b §3/§6 — сузьте окно Storybook <640px, чтобы увидеть mobile-лист «Официальный
 * текст (English)»; >=640px — открывается `CompareColumns` инлайн (desktop).
 */
export const Interactive: Story = {
  render: () => {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button variant="ghost" onClick={() => setOpen(true)}>
          Официальный текст — English · Показать
        </Button>
        <OfficialTextView
          open={open}
          onClose={() => setOpen(false)}
          closeLabel="Закрыть"
          sheetTitle="Официальный текст (English)"
          sheetSubtitle="Это версия, которая подписывается. Ваш экран — перевод для удобства."
          footnote="При расхождении перевода и официального текста действует официальный (English)."
          officialText="This is the official version of the agreement. It governs the relationship between the parties as recorded in this frozen version."
          viewerLabel="Ваш язык (автоперевод)"
          viewerText="Это официальная версия договора. Он определяет отношения сторон в зафиксированном виде."
          officialLabel="Официальный текст (English)"
        />
      </>
    );
  },
};
