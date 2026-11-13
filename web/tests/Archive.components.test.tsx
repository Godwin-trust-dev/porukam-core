import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExportCta, PackageOptions, PackagePreview, ReadyState, StoragePlashka, VerifyPanel } from '@porukam/ui';

describe('PackagePreview (DEV-12) — секции с галочками/размерами, частично при снимке', () => {
  it('complete → галочка, не показывает счётчик', () => {
    render(
      <PackagePreview
        sections={[{ key: 'contract', label: 'Договор и все версии', sub: 'v2 · подписан', complete: true, countLabel: '999' }]}
      />,
    );
    const row = screen.getByTestId('package-preview-row');
    expect(within(row).queryByText('999')).not.toBeInTheDocument();
  });

  it('несdone (снимок) → показывает размер/количество вместо галочки', () => {
    render(<PackagePreview sections={[{ key: 'evidence', label: 'Доказательства', complete: false, countLabel: '5,4 МБ' }]} />);
    expect(screen.getByText('5,4 МБ')).toBeInTheDocument();
  });
});

describe('VerifyPanel (DEV-12 §4 ⭐) — раскрытие шагов + HashList', () => {
  it('компактно скрывает шаги, «Как это работает ›» раскрывает манифест', async () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <VerifyPanel
        title="Проверяется без нас"
        compactText="В пакете — манифест хешей"
        howLabel="Как это работает ›"
        open={false}
        onToggle={onToggle}
        steps={['Шаг 1', 'Шаг 2']}
        hashRows={[{ file: 'договор.pdf', hash: 'sha256: abc…' }]}
        timestampLabel="time-stamp → RFC 3161 · 5 авг 2026"
        whyTitle="Почему без платформы"
        whyText="Заинтересованный свидетель"
      />,
    );
    expect(screen.queryByText('Шаг 1')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Как это работает ›', expanded: false }));
    expect(onToggle).toHaveBeenCalledOnce();

    rerender(
      <VerifyPanel
        title="Проверяется без нас"
        compactText="В пакете — манифест хешей"
        howLabel="Как это работает ›"
        open
        onToggle={onToggle}
        steps={['Шаг 1', 'Шаг 2']}
        hashRows={[{ file: 'договор.pdf', hash: 'sha256: abc…' }]}
        timestampLabel="time-stamp → RFC 3161 · 5 авг 2026"
        whyTitle="Почему без платформы"
        whyText="Заинтересованный свидетель"
      />,
    );
    expect(screen.getByText('Шаг 1')).toBeInTheDocument();
    expect(screen.getByTestId('hash-list')).toHaveTextContent('договор.pdf');
    expect(screen.getByText('Почему без платформы')).toBeInTheDocument();
  });
});

describe('PackageOptions (DEV-12 §4/§7) — взаимоисключающие, full отключён при Drive off', () => {
  it('radiogroup из трёх пунктов, выбор меняет value через onChange', async () => {
    const onChange = vi.fn();
    render(
      <PackageOptions
        value="thumbnails"
        onChange={onChange}
        groupLabel="Что включить в архив"
        fullLabel="Полный пакет"
        fullHint="Оригиналы из Google Drive"
        thumbnailsLabel="Миниатюры"
        thumbnailsHint="Превью + манифест"
        manifestLabel="Только манифест"
        manifestHint="Самый лёгкий"
      />,
    );
    const group = screen.getByRole('radiogroup', { name: 'Что включить в архив' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(3);
    await userEvent.click(screen.getByRole('radio', { name: /Только манифест/ }));
    expect(onChange).toHaveBeenCalledWith('manifest_only');
  });

  it('«Полный пакет» недоступен при отключённом Drive, показывает подсказку', () => {
    render(
      <PackageOptions
        value="thumbnails"
        onChange={() => {}}
        groupLabel="Что включить в архив"
        fullLabel="Полный пакет"
        fullHint="Оригиналы из Google Drive"
        fullDisabled
        fullDisabledHint="оригиналы у вас; подключите Drive или приложите сами"
        thumbnailsLabel="Миниатюры"
        thumbnailsHint="Превью + манифест"
        manifestLabel="Только манифест"
        manifestHint="Самый лёгкий"
      />,
    );
    expect(screen.getByRole('radio', { name: /Полный пакет/ })).toBeDisabled();
    expect(screen.getByText('оригиналы у вас; подключите Drive или приложите сами')).toBeInTheDocument();
  });
});

describe('StoragePlashka (DEV-12) — без строк про сроки/истечение хранения', () => {
  it('info/ok не упоминают дни/срок/истечение', () => {
    render(<StoragePlashka tone="info" title="Оригиналы у вас" text="У платформы — хеш и миниатюра (бессрочно)." />);
    expect(screen.queryByText(/истек|истёк|срок хранения|дней до удаления/i)).not.toBeInTheDocument();

    render(<StoragePlashka tone="ok" title="Оригиналы у вас и в Drive" text="Оригиналы у вас и в Google Drive." />);
    expect(screen.queryByText(/истек|истёк|срок хранения|дней до удаления/i)).not.toBeInTheDocument();
  });
});

describe('ExportCta (DEV-12 §4 ⭐) — бесплатно, без пейвола', () => {
  it('рендерит переданный текст (напр. «Собрать снимок») и подпись «Бесплатно», вызывает onClick', async () => {
    const onClick = vi.fn();
    render(<ExportCta label="Собрать снимок" hint="Бесплатно · PDF + ZIP" onClick={onClick} />);
    expect(screen.getByText('Бесплатно · PDF + ZIP')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('export-cta'));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('ReadyState (DEV-12) — ссылки PDF/ZIP + expires_at', () => {
  it('вызывает onDownload* и показывает срок действия ссылок', async () => {
    const onPdf = vi.fn();
    const onZip = vi.fn();
    render(
      <ReadyState
        title="Архив готов"
        pdfLabel="Скачать PDF"
        pdfSizeLabel="1,2 МБ"
        onDownloadPdf={onPdf}
        zipLabel="Скачать ZIP"
        zipSizeLabel="21,4 МБ"
        onDownloadZip={onZip}
        expiresLabel="Ссылки активны 30 дней · собрать заново можно всегда"
      />,
    );
    await userEvent.click(screen.getByTestId('download-pdf'));
    await userEvent.click(screen.getByTestId('download-zip'));
    expect(onPdf).toHaveBeenCalledOnce();
    expect(onZip).toHaveBeenCalledOnce();
    expect(screen.getByText(/Ссылки активны 30 дней/)).toBeInTheDocument();
  });
});
