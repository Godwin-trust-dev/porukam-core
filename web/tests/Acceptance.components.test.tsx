import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Ceremony,
  AcceptanceTimer,
  ChecklistAcceptItem,
  EvidenceFiles,
  WaitingSubmission,
  type ChecklistDecision,
} from '@porukam/ui';

describe('AcceptanceTimer (DEV-04)', () => {
  it('показывает значение и подпись текстом (не только цветом)', () => {
    render(<AcceptanceTimer valueLabel="42 ч осталось" hint="Автоприёмка, если не ответите" />);
    expect(screen.getByText('42 ч осталось')).toBeInTheDocument();
    expect(screen.getByText('Автоприёмка, если не ответите')).toBeInTheDocument();
  });
});

describe('EvidenceFiles (DEV-04) — без меток', () => {
  it('рендерит файлы списком и вызывает onOpen по тапу', async () => {
    const onOpen = vi.fn();
    render(
      <EvidenceFiles
        files={[
          { id: 'f1', name: 'Фото 1.jpg', kind: 'image', src: 'https://placehold.co/10x10' },
          { id: 'f2', name: 'Акт.pdf', kind: 'doc' },
        ]}
        onOpen={onOpen}
      />,
    );
    const items = screen.getAllByRole('button');
    expect(items).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Акт.pdf' }));
    expect(onOpen).toHaveBeenCalledWith({ id: 'f2', name: 'Акт.pdf', kind: 'doc' });
  });
});

const CHECKLIST_LABELS = {
  acceptLabel: 'Принять',
  remarkLabel: 'Замечание',
  notePlaceholder: 'Опишите замечание',
  attachLabel: 'Приложить файл',
  groupLabel: 'Решение по пункту',
};

describe('ChecklistAcceptItem (DEV-04) — отклонение только по пункту с доказательством (ADR-017)', () => {
  it('выбор «Замечание» раскрывает поле описания и кнопку прикрепить файл', async () => {
    const onChange = vi.fn();
    render(
      <ChecklistAcceptItem
        label="Плинтус установлен"
        value={null}
        onChange={onChange}
        note=""
        onNoteChange={() => {}}
        onFileChange={() => {}}
        {...CHECKLIST_LABELS}
      />,
    );
    expect(screen.queryByLabelText('Опишите замечание')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Замечание' }));
    expect(onChange).toHaveBeenCalledWith('remark');
  });

  it('раскрытая панель показывает описание и прикреплённый файл', () => {
    render(
      <ChecklistAcceptItem
        label="Плинтус установлен"
        value="remark"
        onChange={() => {}}
        note="Не закреплён в углу"
        onNoteChange={() => {}}
        onFileChange={() => {}}
        attachedFileName="фото-угол.jpg"
        {...CHECKLIST_LABELS}
      />,
    );
    expect(screen.getByLabelText('Опишите замечание')).toHaveValue('Не закреплён в углу');
    expect(screen.getByText('фото-угол.jpg')).toBeInTheDocument();
  });

  it('радиокнопки решения доступны как единая группа (a11y)', () => {
    function Wrapper() {
      const [value, setValue] = useState<ChecklistDecision | null>(null);
      return (
        <ChecklistAcceptItem
          label="Пункт"
          value={value}
          onChange={setValue}
          note=""
          onNoteChange={() => {}}
          onFileChange={() => {}}
          {...CHECKLIST_LABELS}
        />
      );
    }
    render(<Wrapper />);
    const group = screen.getByRole('radiogroup', { name: 'Решение по пункту' });
    expect(within(group).getAllByRole('radio')).toHaveLength(2);
  });
});

describe('Ceremony (DEV-04/DEV-05) — искра только здесь на потоке приёмки/подписания', () => {
  it('open=false ничего не рендерит; open=true фокусирует «Готово», Esc завершает', async () => {
    const onDone = vi.fn();
    const { rerender } = render(
      <Ceremony open={false} title="Этап принят — по рукам!" subtitle="Идёт в репутацию" doneLabel="Готово" onDone={onDone} />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    rerender(<Ceremony open title="Этап принят — по рукам!" subtitle="Идёт в репутацию" doneLabel="Готово" onDone={onDone} />);
    expect(screen.getByRole('button', { name: 'Готово' })).toHaveFocus();

    await userEvent.keyboard('{Escape}');
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('не упоминает деньги в тексте церемонии', () => {
    render(<Ceremony open title="Этап принят — по рукам!" subtitle="Этап закрыт, идёт в репутацию" doneLabel="Готово" onDone={() => {}} />);
    expect(screen.queryByText(/₽/)).not.toBeInTheDocument();
  });

  it('опциональный chip рендерится под подписью (напр. хеш версии на подписании)', () => {
    render(
      <Ceremony
        open
        title="Договор подписан — по рукам!"
        subtitle="Версия зафиксирована"
        doneLabel="Перейти к исполнению"
        chip="🔒 v1 · a1b2c3d4… · 31 июля 2026"
        onDone={() => {}}
      />,
    );
    expect(screen.getByText(/a1b2c3d4/)).toBeInTheDocument();
  });
});

describe('WaitingSubmission (DEV-04) — «ожидаем сдачу»', () => {
  it('показывает срок и вызывает onChat', async () => {
    const onChat = vi.fn();
    render(<WaitingSubmission scheduleLabel="Осталось 2 дня" chatLabel="Написать в чат" onChat={onChat} />);
    expect(screen.getByText('Осталось 2 дня')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Написать в чат' }));
    expect(onChat).toHaveBeenCalledOnce();
  });
});
