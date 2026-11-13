import type { Meta, StoryObj } from '@storybook/react';
import { NotificationItem, type NotificationItemProps } from './NotificationItem';

const meta: Meta<typeof NotificationItem> = {
  title: 'Компоненты/NotificationItem',
  component: NotificationItem,
};
export default meta;
type Story = StoryObj<typeof NotificationItem>;

const unreadDueArgs: NotificationItemProps = {
  icon: 'calendar',
  severity: 'due',
  title: 'Срок приёмки этапа истекает через 2 часа',
  metaLabel: 'Мастер Ремонт · Ремонт кухни, 12 м²',
  timeLabel: '2 ч назад',
  exactTimeLabel: '8 августа 2026, 09:10',
  unread: true,
  unreadAriaLabel: 'Непрочитано',
  onOpen: () => {},
};

const unreadNormalArgs: NotificationItemProps = {
  icon: 'discuss',
  severity: 'normal',
  title: 'Новое предложение по условиям договора',
  metaLabel: 'Анна Свет · Электромонтаж в новостройке',
  timeLabel: 'вчера',
  exactTimeLabel: '7 августа 2026, 15:05',
  unread: true,
  unreadAriaLabel: 'Непрочитано',
  onOpen: () => {},
};

const readGoodArgs: NotificationItemProps = {
  icon: 'wallet',
  severity: 'good',
  title: 'Оплата этапа получена',
  metaLabel: 'Николай Гром · Укладка ламината, 42 м²',
  amountLabel: '54 000 ₽',
  timeLabel: '3 авг',
  exactTimeLabel: '3 августа 2026, 09:00',
  unread: false,
  unreadAriaLabel: 'Непрочитано',
  onOpen: () => {},
};

const noActionArgs: NotificationItemProps = {
  icon: 'milestone',
  severity: 'normal',
  title: 'Этап сдан на приёмку',
  metaLabel: 'Дмитрий Косяк · Сборка мебели, гостиная',
  timeLabel: '1 ч назад',
  exactTimeLabel: '8 августа 2026, 08:00',
  unread: true,
  unreadAriaLabel: 'Непрочитано',
  onOpen: () => {},
};

export const UnreadDue: Story = { args: unreadDueArgs };
export const UnreadNormal: Story = { args: unreadNormalArgs };
export const ReadGood: Story = { args: readGoodArgs };
export const NoAction: Story = { args: noActionArgs };

export const Feed: Story = {
  render: () => (
    <div style={{ maxWidth: 480, background: 'var(--pr-white)', borderRadius: 'var(--pr-r-lg)', overflow: 'hidden' }}>
      <NotificationItem {...unreadDueArgs} />
      <NotificationItem {...unreadNormalArgs} />
      <NotificationItem {...readGoodArgs} />
      <NotificationItem {...noActionArgs} />
    </div>
  ),
};

/** Выбранный пункт master-detail (DEV-19 §2) — раскрыт в колонке справа. */
export const SelectedInMasterDetail: Story = {
  render: () => (
    <div style={{ maxWidth: 360, background: 'var(--pr-white)', borderRadius: 'var(--pr-r-lg)', overflow: 'hidden' }}>
      <NotificationItem {...unreadDueArgs} selected />
      <NotificationItem {...unreadNormalArgs} />
      <NotificationItem {...readGoodArgs} />
    </div>
  ),
};
