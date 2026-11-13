import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PassportHeader } from '@porukam/ui';

// Отсмотр 2026-08-21: хендл копируется одним нажатием.
describe('PassportHeader — копирование хендла', () => {
  it('с onCopyHandle хендл — кнопка: тап копирует и показывает «Скопировано»', async () => {
    const onCopy = vi.fn();
    render(
      <PassportHeader surface="light" name="Маша" handle="@masha" expandLabel="Открыть" actions={null}
        onCopyHandle={onCopy} copyHandleLabel="Скопировать хендл" copiedLabel="Скопировано" />,
    );
    const btn = screen.getByTestId('passport-handle-copy');
    expect(btn).toHaveTextContent('@masha');
    await userEvent.click(btn);
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(btn).toHaveTextContent('Скопировано');
  });

  it('без onCopyHandle хендл — обычный текст', () => {
    render(<PassportHeader surface="light" name="Маша" handle="@masha" expandLabel="Открыть" actions={null} />);
    expect(screen.queryByTestId('passport-handle-copy')).not.toBeInTheDocument();
    expect(screen.getByText('@masha')).toBeInTheDocument();
  });
});
