import type { Meta, StoryObj } from '@storybook/react';
import { FormatRow } from './FormatRow';
import { PackageOptions } from './PackageOptions';
import { PackagePreview } from './PackagePreview';
import { StoragePlashka } from './StoragePlashka';
import { VerifyPanel } from './VerifyPanel';

/**
 * Витрина композиции DEV-12 (не отдельный экспортируемый компонент — сама страница
 * `ArchivePage.tsx` живёт в `web/`, Storybook её не видит): показывает двухпанельную
 * раскладку desktop (§7) — слева `PackagePreview` + `PackageOptions`, справа `VerifyPanel`
 * + `StoragePlashka`.
 */
function DesktopLayout(): JSX.Element {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--pr-sp-5)', maxWidth: 1080 }}>
      <div style={{ display: 'grid', gap: 'var(--pr-sp-5)' }}>
        <div style={{ background: 'var(--pr-white)', border: '1px solid var(--pr-line)', borderRadius: 'var(--pr-r-lg)', padding: 'var(--pr-sp-5)' }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 'var(--pr-fs-h3)', color: 'var(--pr-ink)' }}>Что войдёт в пакет</h3>
          <PackagePreview
            sections={[
              { key: 'contract', label: 'Договор и все версии', sub: 'v2 · подписан 3 июля 2026', complete: true },
              { key: 'milestones', label: 'Этапы и чек-листы', sub: '5 этапов, все приняты', complete: true },
              { key: 'evidence', label: 'Доказательства', sub: '9 файлов', complete: true },
              { key: 'payments', label: 'Платежи', sub: 'все проведены', complete: true },
            ]}
          />
        </div>
        <div style={{ background: 'var(--pr-white)', border: '1px solid var(--pr-line)', borderRadius: 'var(--pr-r-lg)', padding: 'var(--pr-sp-5)' }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 'var(--pr-fs-h3)', color: 'var(--pr-ink)' }}>Форматы</h3>
          <FormatRow pdfLabel="PDF" pdfHint="Отчёт с оглавлением — для чтения" zipLabel="ZIP" zipHint="Файлы + манифест хешей — для проверки" zipSizeLabel="21,4 МБ" />
        </div>
        <div style={{ background: 'var(--pr-white)', border: '1px solid var(--pr-line)', borderRadius: 'var(--pr-r-lg)', padding: 'var(--pr-sp-5)' }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 'var(--pr-fs-h3)', color: 'var(--pr-ink)' }}>Опции пакета</h3>
          <PackageOptions
            value="full"
            onChange={() => {}}
            groupLabel="Что включить в архив"
            fullLabel="Полный пакет"
            fullHint="Оригиналы из Google Drive — тяжелее"
            thumbnailsLabel="Миниатюры"
            thumbnailsHint="Превью файлов + манифест хешей"
            manifestLabel="Только манифест"
            manifestHint="Список и хеши файлов — самый лёгкий"
          />
        </div>
      </div>
      <div style={{ display: 'grid', gap: 'var(--pr-sp-5)' }}>
        <VerifyPanel
          title="Проверяется без нас"
          compactText="В пакете — манифест хешей и инструкция. Целостность можно подтвердить самому, без участия платформы."
          howLabel="Как это работает ›"
          open={false}
          onToggle={() => {}}
          steps={['Скачайте ZIP — внутри manifest.txt', 'Посчитайте sha256 файла', 'Сверьте с manifest.txt', 'Совпало — файл подлинный']}
          hashRows={[{ file: 'договор.pdf', hash: 'sha256: a1b2c3d4e5f6…' }]}
          timestampLabel="time-stamp → RFC 3161 · 5 авг 2026"
          whyTitle="Почему без платформы"
          whyText="Если целостность подтверждает только платформа — она заинтересованный свидетель."
        />
        <StoragePlashka
          tone="ok"
          title="Оригиналы у вас и в Drive"
          text="Оригиналы у вас и в Google Drive. У платформы — хеш и миниатюра (бессрочно)."
        />
      </div>
    </div>
  );
}

const meta: Meta<typeof DesktopLayout> = {
  title: 'Компоненты/ArchiveExportShowcase',
  component: DesktopLayout,
};
export default meta;
type Story = StoryObj<typeof DesktopLayout>;

export const DesktopTwoPanel: Story = { args: {} };
