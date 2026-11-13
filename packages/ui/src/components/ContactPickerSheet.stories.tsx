import type { Meta, StoryObj } from '@storybook/react';
import { ContactPickerSheet } from './ContactPickerSheet';

const meta: Meta<typeof ContactPickerSheet> = {
  title: 'Компоненты/ContactPickerSheet',
  component: ContactPickerSheet,
};
export default meta;
type Story = StoryObj<typeof ContactPickerSheet>;

const base = {
  open: true,
  onClose: () => {},
  title: 'Контакты',
  closeLabel: 'Закрыть',
  onQueryChange: () => {},
  searchLabel: 'Поиск по контактам',
  searchPlaceholder: 'Имя или @хендл',
  emptyTitle: 'Сохранённых контактов пока нет',
  emptyText: 'Вставьте @хендл в поле.',
  onSearchPlatform: () => {},
  platformEmptyText: 'На платформе никого не нашли.',
  platformPendingText: 'Загрузка…',
  savedLabel: 'в контактах',
  noHandleHint: 'нет @хендла — договор заключить нельзя',
  onPick: () => {},
};

const contacts = [
  { id: 'c1', name: 'Мастер Ремонт', handle: '@masterremont' },
  { id: 'c2', name: 'Ирина Соколова', handle: '@irina_s' },
  { id: 'c3', name: 'Мария Соколова', handle: null },
];

export const Saved: Story = {
  args: {
    ...base,
    query: '',
    contacts,
    contactsEmpty: false,
    platformActive: false,
    searchPlatformLabel: '',
  },
};

export const NoMatchOffersPlatform: Story = {
  args: {
    ...base,
    query: 'svetdom',
    contacts: [],
    contactsEmpty: false,
    platformActive: false,
    searchPlatformLabel: 'Искать @svetdom на платформе',
  },
};

export const PlatformResults: Story = {
  args: {
    ...base,
    query: 'svetdom',
    contacts: [],
    contactsEmpty: false,
    platformActive: true,
    platformResults: [{ id: '@svetdom', name: 'ООО «СветДом»', handle: '@svetdom', saved: false }],
    searchPlatformLabel: 'Искать @svetdom на платформе',
  },
};

export const Empty: Story = {
  args: {
    ...base,
    query: '',
    contacts: [],
    contactsEmpty: true,
    platformActive: false,
    searchPlatformLabel: '',
  },
};
