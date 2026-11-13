import { screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

/**
 * Выбор значения в комбобоксе `SearchSelect` (@porukam/ui): открыть поле,
 * найти пункт по основной строке, нажать. Заменяет `user.selectOptions` там,
 * где нативный `<select>` уступил место комбобоксу с поиском.
 */
export async function pickSearchOption(
  user: UserEvent,
  testId: string,
  label: string | RegExp,
): Promise<void> {
  await user.click(await screen.findByTestId(testId));
  const list = await screen.findByRole('listbox');
  await user.click(within(list).getByText(label));
}

/** То же, но со вводом в поиск — проверяет и фильтрацию, и выбор. */
export async function searchAndPick(
  user: UserEvent,
  testId: string,
  query: string,
  label: string | RegExp,
): Promise<void> {
  const input = await screen.findByTestId(testId);
  await user.click(input);
  await user.type(input, query);
  const list = await screen.findByRole('listbox');
  await user.click(within(list).getByText(label));
}
