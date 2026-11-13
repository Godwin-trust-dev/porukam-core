import type { Meta, StoryObj } from '@storybook/react';
import { NotificationItem } from './NotificationItem';
import { PushPromo } from './PushPromo';
import { SettingRow } from './SettingRow';
import { Badge } from './Badge';
import { EmptyState } from './States';

/**
 * Витрина композиции DEV-14 (страницы `NotificationsPage`/`NotificationsSettingsPage`
 * живут в `web/`, Storybook их не видит — тот же приём, что `ArchiveExportShowcase`):
 * лента (непрочитанные/типы), промо push, запрос push (default/denied), настройки,
 * пусто, desktop-двухпанельно (§7/§9).
 */
const meta: Meta = { title: 'Витрины/Notifications (DEV-14)' };
export default meta;
type Story = StoryObj;

function Panel({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ background: 'var(--pr-white)', border: '1px solid var(--pr-line)', borderRadius: 'var(--pr-r-lg)', overflow: 'hidden' }}>
      <h3 style={{ margin: 0, padding: 'var(--pr-sp-4) var(--pr-sp-4) 0', fontSize: 'var(--pr-fs-h3)', color: 'var(--pr-ink)' }}>{title}</h3>
      {children}
    </div>
  );
}

export const Feed: Story = {
  render: () => (
    <div style={{ maxWidth: 480, display: 'grid', gap: 'var(--pr-sp-5)' }}>
      <PushPromo
        titleLabel="Разрешите отправлять уведомления, чтобы не пропустить сроки"
        enableLabel="Включить"
        dismissAriaLabel="Скрыть"
        onEnable={() => {}}
        onDismiss={() => {}}
      />
      <Panel title="Сегодня">
        <NotificationItem
          icon="calendar"
          severity="due"
          title="Срок приёмки этапа истекает через 2 часа"
          metaLabel="Мастер Ремонт · Ремонт кухни, 12 м²"
          timeLabel="2 ч назад"
          exactTimeLabel="8 августа 2026, 09:10"
          unread
          unreadAriaLabel="Непрочитано"
          onOpen={() => {}}
        />
        <NotificationItem
          icon="milestone"
          severity="normal"
          title="Этап сдан на приёмку"
          metaLabel="Дмитрий Косяк · Сборка мебели, гостиная"
          timeLabel="1 ч назад"
          exactTimeLabel="8 августа 2026, 08:00"
          unread
          unreadAriaLabel="Непрочитано"
          onOpen={() => {}}
        />
        <NotificationItem
          icon="milestone"
          severity="due"
          title="Этап сдан на приёмку"
          metaLabel="Игорь Волков · Сборка мебели, спальня"
          timeLabel="55 мин назад"
          exactTimeLabel="8 августа 2026, 08:05"
          unread
          unreadAriaLabel="Непрочитано"
          onOpen={() => {}}
        />
      </Panel>
      <Panel title="Ранее">
        <NotificationItem
          icon="wallet"
          severity="good"
          title="Оплата этапа получена"
          metaLabel="Николай Гром · Укладка ламината, 42 м²"
          amountLabel="54 000 ₽"
          timeLabel="3 авг"
          exactTimeLabel="3 августа 2026, 09:00"
          unread={false}
          unreadAriaLabel="Непрочитано"
          onOpen={() => {}}
        />
        <NotificationItem
          icon="dispute"
          severity="normal"
          title="Открыт спор по этапу"
          metaLabel="Анна Свет · Электромонтаж в новостройке"
          timeLabel="2 авг"
          exactTimeLabel="2 августа 2026, 13:30"
          unread={false}
          unreadAriaLabel="Непрочитано"
          onOpen={() => {}}
        />
      </Panel>
    </div>
  ),
};

export const Empty: Story = {
  render: () => (
    <div style={{ maxWidth: 480 }}>
      <EmptyState icon="bell" title="Пока пусто" text="Здесь появятся события по вашим сделкам" />
    </div>
  ),
};

function SettingsPanel({ pushPermission }: { pushPermission: 'default' | 'granted' | 'denied' }): JSX.Element {
  return (
    <div style={{ maxWidth: 420, display: 'grid' }}>
      <h3 style={{ fontSize: 'var(--pr-fs-h3)', color: 'var(--pr-ink)' }}>Каналы</h3>
      <SettingRow label="Лента в приложении" control="static" staticValue={<Badge tone="teal">Всегда</Badge>} />
      <SettingRow
        label="Push-уведомления"
        hint={pushPermission === 'denied' ? 'Уведомления выключены в настройках устройства' : 'Дублировать уведомления push-сообщением'}
        control="toggle"
        checked={pushPermission === 'granted'}
        disabled={pushPermission === 'denied'}
        onToggle={() => {}}
        toggleOnLabel="Вкл"
        toggleOffLabel="Выкл"
      />
      <SettingRow
        label="Email"
        hint="Дублировать уведомления на go••••n@example.com"
        control="toggle"
        checked={false}
        onToggle={() => {}}
        toggleOnLabel="Вкл"
        toggleOffLabel="Выкл"
      />
      <h3 style={{ fontSize: 'var(--pr-fs-h3)', color: 'var(--pr-ink)', marginTop: 'var(--pr-sp-5)' }}>Что дублировать в push и email</h3>
      <p style={{ color: 'var(--pr-text-2)', fontSize: 'var(--pr-fs-sm)' }}>
        Лента показывает всё всегда — тумблеры влияют только на push и email
      </p>
      {['Сделки', 'Платежи', 'Напоминания о сроках', 'Споры'].map((label) => (
        <SettingRow key={label} label={label} control="toggle" checked onToggle={() => {}} toggleOnLabel="Вкл" toggleOffLabel="Выкл" />
      ))}
    </div>
  );
}

export const SettingsPushDefault: Story = { render: () => <SettingsPanel pushPermission="default" /> };
export const SettingsPushGranted: Story = { render: () => <SettingsPanel pushPermission="granted" /> };
export const SettingsPushDenied: Story = { render: () => <SettingsPanel pushPermission="denied" /> };

export const DesktopTwoColumn: Story = {
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 'var(--pr-sp-5)', maxWidth: 980 }}>
      <div style={{ maxWidth: 560 }}>{(Feed.render as () => JSX.Element)()}</div>
      <SettingsPanel pushPermission="default" />
    </div>
  ),
};
