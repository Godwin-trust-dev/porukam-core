import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ChatBubble, ChatComposer, ChatDay, ChatLog, ChatSystemEvent } from './Chat';

const meta: Meta<typeof ChatLog> = {
  title: 'Компоненты/Chat',
  component: ChatLog,
};
export default meta;
type Story = StoryObj<typeof ChatLog>;

function Thread(): JSX.Element {
  const [draft, setDraft] = useState('');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '70vh' }}>
      <ChatLog>
        <ChatDay>Сегодня</ChatDay>
        <ChatBubble direction="in" timeLabel="12:30">
          Здравствуйте! Отправила этап на приёмку, посмотрите фото.
        </ChatBubble>
        {/* §5: событие сделки — системной плашкой в той же ленте. */}
        <ChatSystemEvent timeLabel="12:31">Этап «Чистовая отделка» отправлен на приёмку · 40 000 ₽</ChatSystemEvent>
        <ChatBubble direction="out" timeLabel="12:38">
          Спасибо! Гляну сегодня вечером и приму.
        </ChatBubble>
        <ChatBubble direction="in" timeLabel="12:40">
          Хорошо, приму сегодня 🙌
        </ChatBubble>
      </ChatLog>
      <ChatComposer
        value={draft}
        onChange={setDraft}
        onSubmit={() => setDraft('')}
        placeholder="Сообщение…"
        inputLabel="Сообщение"
        sendLabel="Отправить"
      />
    </div>
  );
}

export const ПерепискаТелефон: Story = {
  parameters: { viewport: { defaultViewport: 'w360' } },
  render: () => <Thread />,
};

export const ПерепискаДесктоп: Story = {
  parameters: { viewport: { defaultViewport: 'w1440' } },
  render: () => <Thread />,
};
