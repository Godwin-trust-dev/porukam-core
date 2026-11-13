import type { Meta, StoryObj } from '@storybook/react';
import { VerifyPanel } from './VerifyPanel';

const meta: Meta<typeof VerifyPanel> = {
  title: 'Компоненты/VerifyPanel',
  component: VerifyPanel,
};
export default meta;
type Story = StoryObj<typeof VerifyPanel>;

const base = {
  title: 'Проверяется без нас',
  compactText: 'В пакете — манифест хешей и инструкция. Целостность можно подтвердить самому, без участия платформы.',
  howLabel: 'Как это работает ›',
  onToggle: () => {},
  // Шаги — часть 2 README пакета: команда рендерится узлом (<code>), не строкой.
  steps: [
    'Распакуйте package.zip (и files.zip, если скачивали) в одну папку',
    <>
      В этой папке выполните команду своей системы:
      <ul style={{ margin: '8px 0 0', paddingInlineStart: 0, listStyle: 'none', display: 'grid', gap: 8 }}>
        <li>
          Windows — PowerShell: <code dir="ltr">powershell -ExecutionPolicy Bypass -File .\verify.ps1</code>
        </li>
        <li>
          macOS — Терминал: <code dir="ltr">shasum -a 256 -c SHA256SUMS</code>
        </li>
        <li>
          Linux — терминал: <code dir="ltr">sha256sum -c SHA256SUMS</code>
        </li>
      </ul>
    </>,
    'У каждой строки должно стоять «OK». «FAILED» — файл изменён; «ПРОПУЩЕН» / «MISSING» — файла нет в распакованной папке',
    'Подробно и для эксперта — цепочка Audit Vault, метка времени RFC 3161 — в README.txt внутри пакета',
  ],
  hashRows: [
    { file: 'договор.pdf', hash: 'sha256: a1b2c3d4e5f6…' },
    { file: 'доказательство-01.jpg', hash: 'sha256: 9f8e7d6c5b4a…' },
  ],
  timestampLabel: 'time-stamp → RFC 3161 · 5 авг 2026',
  whyTitle: 'Почему без платформы',
  whyText: 'Если целостность подтверждает только платформа — она заинтересованный свидетель. Манифест снимает вопрос.',
};

export const Compact: Story = { args: { ...base, open: false } };
export const Expanded: Story = { args: { ...base, open: true } };
