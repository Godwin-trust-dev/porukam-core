import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AcceptanceChecklist,
  DriveBackupPrompt,
  EvidenceList,
  EvidenceUploader,
  StartConditions,
  StoragePlashka,
  SuspendedBanner,
} from '@porukam/ui';

const STATE_LABELS = { met: 'Готово', waiting: 'Ждём', na: 'Не требуется' };

describe('StartConditions (DEV-11) — каждая строка ссылка (§2 ⭐)', () => {
  it('строка со ссылкой вызывает onOpen(link_ref), строка без ссылки — не кликабельна', async () => {
    const onOpen = vi.fn();
    render(
      <StartConditions
        title="Что нужно для старта"
        items={[
          { key: 'contract_signed', label: 'Договор подписан', state: 'met', linkRef: 'contract' },
          { key: 'advance', label: 'Аванс получен', state: 'na' },
        ]}
        stateLabels={STATE_LABELS}
        openLabel="Открыть"
        onOpen={onOpen}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Договор подписан/ }));
    expect(onOpen).toHaveBeenCalledWith('contract');
    expect(screen.queryByRole('button', { name: /Аванс получен/ })).not.toBeInTheDocument();
    expect(screen.getByText('Аванс получен')).toBeInTheDocument();
  });
});

describe('AcceptanceChecklist (DEV-11) — доказательство у пункта необязательно (§4 ⭐)', () => {
  it('показывает «+ Приложить», меняется на счётчик после прикрепления; optional-бейдж рядом', () => {
    render(
      <AcceptanceChecklist
        items={[
          { id: 'a', label: 'Плитка уложена', optional: false, attachedLabel: undefined },
          { id: 'b', label: 'Мусор вывезен', optional: true, optionalLabel: 'необязательно', attachedLabel: 'приложено · 2' },
        ]}
        attachLabel="+ Приложить"
        onAttach={() => {}}
      />,
    );
    const rows = screen.getAllByTestId('checklist-item');
    expect(within(rows[0]!).getByText('+ Приложить')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('приложено · 2')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('необязательно')).toBeInTheDocument();
  });

  it('выбор файла вызывает onAttach(itemId, file)', async () => {
    const onAttach = vi.fn();
    render(<AcceptanceChecklist items={[{ id: 'a', label: 'Плитка уложена', optional: false }]} attachLabel="+ Приложить" onAttach={onAttach} />);
    const file = new File(['x'], 'фото.jpg', { type: 'image/jpeg' });
    await userEvent.upload(screen.getByLabelText('+ Приложить · Плитка уложена'), file);
    expect(onAttach).toHaveBeenCalledWith('a', file);
  });
});

describe('EvidenceUploader (DEV-11) — drag-drop + выбор файлов, привязка, заглушка камеры', () => {
  it('выбор через input вызывает onSelectFiles; смена привязки — onBindChange', async () => {
    const onSelectFiles = vi.fn();
    const onBindChange = vi.fn();
    render(
      <EvidenceUploader
        dropLabel="Перетащите файлы сюда"
        browseLabel="Выбрать файлы"
        bindLabel="Привязать к"
        bindHint="Привяжите к пункту — понятнее на приёмке"
        bindOptions={[{ id: 'stage', label: 'Этап целиком' }, { id: 'a', label: 'Плитка уложена' }]}
        bindValue="stage"
        onBindChange={onBindChange}
        onSelectFiles={onSelectFiles}
        cameraStubText="Точная съёмка с метками — в приложении (скоро). Сейчас — веб-загрузка."
      />,
    );
    const file = new File(['x'], 'фото.jpg', { type: 'image/jpeg' });
    await userEvent.upload(screen.getByLabelText('Выбрать файлы'), file);
    expect(onSelectFiles).toHaveBeenCalledWith([file]);

    await userEvent.selectOptions(screen.getByLabelText('Привязать к'), 'a');
    expect(onBindChange).toHaveBeenCalledWith('a');

    expect(screen.getByTestId('camera-stub')).toHaveTextContent('в приложении (скоро)');
  });
});

describe('EvidenceList (DEV-11) — метки раздельно (ADR-036), удаление только до сдачи', () => {
  it('показывает метку задержки отдельно от даты загрузки и от хеша', () => {
    render(
      <EvidenceList
        items={[
          {
            id: 'e1',
            filename: 'Фото.jpg',
            kind: 'image',
            status: 'stored',
            uploadedLabel: 'загружено 5 авг, 12:00',
            lateLabel: 'загружено с задержкой 2 дней',
            hashedLabel: '🔒 хеш зафиксирован',
            bindLabel: 'к этапу',
          },
        ]}
        emptyText="Пока ничего не приложено"
        onView={() => {}}
        deleteLabel="Удалить"
      />,
    );
    expect(screen.getByText('загружено 5 авг, 12:00')).toBeInTheDocument();
    expect(screen.getByText('загружено с задержкой 2 дней')).toBeInTheDocument();
    expect(screen.getByText('🔒 хеш зафиксирован')).toBeInTheDocument();
  });

  it('onDelete отсутствует → кнопка удаления скрыта (после сдачи, §4)', () => {
    render(
      <EvidenceList
        items={[{ id: 'e1', filename: 'Фото.jpg', kind: 'image', status: 'stored', bindLabel: 'к этапу' }]}
        emptyText="Пока ничего не приложено"
        onView={() => {}}
        deleteLabel="Удалить"
      />,
    );
    expect(screen.queryByLabelText(/Удалить · Фото.jpg/)).not.toBeInTheDocument();
  });

  it('onDelete передан → кнопка удаления доступна (до сдачи)', async () => {
    const onDelete = vi.fn();
    render(
      <EvidenceList
        items={[{ id: 'e1', filename: 'Фото.jpg', kind: 'image', status: 'stored', bindLabel: 'к этапу' }]}
        emptyText="Пока ничего не приложено"
        onView={() => {}}
        onDelete={onDelete}
        deleteLabel="Удалить"
      />,
    );
    await userEvent.click(screen.getByLabelText('Удалить · Фото.jpg'));
    expect(onDelete).toHaveBeenCalledWith('e1');
  });

  it('пустой список — нейтральный текст, сдача не блокируется', () => {
    render(<EvidenceList items={[]} emptyText="Пока ничего не приложено — можно сдать и так" onView={() => {}} deleteLabel="Удалить" />);
    expect(screen.getByTestId('evidence-list-empty')).toHaveTextContent('можно сдать и так');
  });
});

describe('StoragePlashka (DEV-11) — честная модель хранения (ADR-060 §8)', () => {
  it('info: не подключён Drive — кнопка подключения', () => {
    render(<StoragePlashka tone="info" title="Оригинал остаётся у вас" text="Платформа хранит хеш" connectLabel="Подключить Drive" onConnect={() => {}} />);
    expect(screen.getByRole('button', { name: 'Подключить Drive' })).toBeInTheDocument();
  });

  it('ok: подключён — бейдж вместо кнопки', () => {
    render(<StoragePlashka tone="ok" title="Копия сохранена в Drive" text="Оригиналы у вас и в Drive" connectedBadge="✓ копия в Drive" />);
    expect(screen.getByText('✓ копия в Drive')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('DriveBackupPrompt (DEV-11) — мягкий промпт на 1-й сдаче, «Позже» не блокирует', () => {
  it('«Позже» вызывает onLater, не onConnect', async () => {
    const onLater = vi.fn();
    const onConnect = vi.fn();
    render(
      <DriveBackupPrompt
        open
        title="Сохраните оригиналы у себя"
        text="Резервная копия в Google Drive"
        connectLabel="Подключить Drive"
        laterLabel="Позже"
        closeLabel="Закрыть"
        onConnect={onConnect}
        onLater={onLater}
      />,
    );
    await userEvent.click(screen.getByTestId('drive-prompt-later'));
    expect(onLater).toHaveBeenCalledOnce();
    expect(onConnect).not.toHaveBeenCalled();
  });
});

describe('SuspendedBanner (DEV-11) — ждём материалы/доступ, срок сдвигается', () => {
  it('показывает заголовок/текст и отметку сдвига срока', () => {
    render(<SuspendedBanner title="Ждём материалы или доступ" text="Работа приостановлена" shiftedLabel="Срок сдвинут" />);
    expect(screen.getByText('Ждём материалы или доступ')).toBeInTheDocument();
    expect(screen.getByText('Срок сдвинут')).toBeInTheDocument();
  });
});
