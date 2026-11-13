import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TextField } from '@porukam/ui';

/** Отсмотр 2026-08-22: подсказка «?» у поля — о чём поле и что вписывать. */
describe('Field — подсказка «?» и обязательность', () => {
  it('«?» раскрывает текст подсказки и связывает его с полем через aria-describedby', async () => {
    render(<TextField label="Цена" help="Полная цена предмета" helpLabel="Подсказка" required />);
    expect(screen.queryByText('Полная цена предмета')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Подсказка' }));
    const note = screen.getByText('Полная цена предмета');
    expect(note).toBeInTheDocument();
    const input = screen.getByLabelText(/Цена/);
    expect(input.getAttribute('aria-describedby')).toContain(note.id);
    expect(input).toBeRequired();
  });
});
