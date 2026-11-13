import type { Meta, StoryObj } from '@storybook/react';
import { EvidenceList } from './EvidenceList';

const meta: Meta<typeof EvidenceList> = {
  title: 'Компоненты/EvidenceList',
  component: EvidenceList,
};
export default meta;
type Story = StoryObj<typeof EvidenceList>;

export const Empty: Story = {
  args: { items: [], emptyText: 'Пока ничего не приложено — можно сдать и так', onView: () => {}, deleteLabel: 'Удалить' },
};

export const WithEvidence: Story = {
  args: {
    items: [
      {
        id: 'e1',
        filename: 'Розетки установлены.jpg',
        kind: 'image',
        thumbUrl: 'https://placehold.co/120x120',
        status: 'stored',
        uploadedLabel: 'загружено 5 авг, 12:00',
        hashedLabel: '🔒 хеш зафиксирован',
        bindLabel: 'к пункту «Плитка уложена»',
      },
      {
        id: 'e2',
        filename: 'Акт расхода материалов.pdf',
        kind: 'doc',
        status: 'stored',
        uploadedLabel: 'загружено 5 авг, 12:04',
        hashedLabel: '🔒 хеш зафиксирован',
        bindLabel: 'к этапу',
      },
    ],
    emptyText: 'Пока ничего не приложено',
    onView: () => {},
    onDelete: () => {},
    deleteLabel: 'Удалить',
  },
};

export const LateUpload: Story = {
  args: {
    items: [
      {
        id: 'e3',
        filename: 'Щиток подключён.jpg',
        kind: 'image',
        thumbUrl: 'https://placehold.co/120x120',
        status: 'stored',
        uploadedLabel: 'загружено 6 авг, 09:10',
        lateLabel: 'загружено с задержкой 2 дней',
        hashedLabel: '🔒 хеш зафиксирован',
        bindLabel: 'к пункту «Швы затёрты»',
      },
    ],
    emptyText: 'Пока ничего не приложено',
    onView: () => {},
    onDelete: () => {},
    deleteLabel: 'Удалить',
  },
};

/** Черновик до сдачи (ADR-160): файл ещё на устройстве — хеша нет, зато есть
 *  корзина. Рядом уже сданное доказательство: у него удаления нет и не будет. */
export const DraftBeforeSubmit: Story = {
  args: {
    items: [
      {
        id: 'd1',
        filename: 'Смазанный кадр.jpg',
        kind: 'image',
        thumbUrl: 'https://placehold.co/120x120',
        status: 'draft',
        draftLabel: 'Черновик — ещё не отправлено',
        bindLabel: 'к пункту «Швы затёрты»',
      },
      {
        id: 'e1',
        filename: 'Розетки установлены.jpg',
        kind: 'image',
        status: 'stored',
        uploadedLabel: 'загружено 5 авг, 12:00',
        hashedLabel: '🔒 хеш зафиксирован',
        bindLabel: 'к этапу',
        deletable: false,
      },
    ],
    emptyText: 'Пока ничего не приложено',
    onView: () => {},
    onDelete: () => {},
    deleteLabel: 'Удалить',
  },
};

export const UploadingAndError: Story = {
  args: {
    items: [
      { id: 'p1', filename: 'Фото-1.jpg', kind: 'image', status: 'uploading', bindLabel: 'к этапу' },
      { id: 'p2', filename: 'Фото-2.jpg', kind: 'image', status: 'uploading', bindLabel: 'к этапу', errorLabel: 'Не удалось загрузить файл' },
    ],
    emptyText: 'Пока ничего не приложено',
    onView: () => {},
    deleteLabel: 'Удалить',
    retryLabel: 'Повторить загрузку',
    onRetry: () => {},
  },
};
