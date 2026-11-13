import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ConsentAgree } from './ConsentAgree';

const meta: Meta<typeof ConsentAgree> = {
  title: 'Компоненты/ConsentAgree',
  component: ConsentAgree,
};
export default meta;
type Story = StoryObj<typeof ConsentAgree>;

export const Unchecked: Story = {
  args: {
    title: 'Your data',
    body: 'We are the operator of the service, not a party to your deals.',
    readMoreLabel: 'Read in full',
    onReadMore: () => {},
    agreeLabel: 'I agree',
    checked: false,
    onChange: () => {},
    required: true,
  },
};

export const Checked: Story = {
  args: { ...Unchecked.args, checked: true },
};

// docs/tasks/Задача_fix_web-consents-crash.md, «Дополнительно» — «Read in
// full» раскрывает `expandedText` под `body` (не мёртвая кнопка).
export const ExpandedReadMore: Story = {
  name: 'Read in full — раскрыт',
  args: {
    ...Unchecked.args,
    readMoreExpanded: true,
    expandedText:
      'We keep only the facts you and your counterparty record — timestamps, hashes, checklist acceptances. We do not decide who is right in a dispute.',
  },
};

function Interactive(): JSX.Element {
  const [checked, setChecked] = useState(false);
  return (
    <ConsentAgree
      title="Your reputation card"
      body="Deal outcomes become history for both sides. It can't be edited — only your whole profile can be deleted."
      agreeLabel="I agree"
      checked={checked}
      onChange={setChecked}
      required
    />
  );
}
export const Interactive_: Story = { name: 'Интерактивный', render: () => <Interactive /> };
