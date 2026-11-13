import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal, Sheet } from '@porukam/ui';

/**
 * Баг 31.08 (`docs/tasks/screenshots_bugs/bug_01_sdelki.png`): окно «Действия»
 * в списке сделок уходило под панель деталей, а крестик переставал нажиматься.
 *
 * Причина не в `z-index`, а в предке: строка списка объявляет
 * `container-type: inline-size` (= `contain: layout`), и этого достаточно, чтобы
 * (а) строка стала содержащим блоком для `position: fixed` потомков и
 * (б) весь `z-index: 100` окна оказался заперт внутри её контекста наложения —
 * ниже соседней `position: sticky` панели деталей.
 *
 * Единственная защита, которая не зависит от вёрстки предков, — портал в
 * `document.body`. Тест закрепляет именно это: окно НЕ должно оставаться
 * в поддереве вызвавшего компонента. Проверять «нужный z-index» бесполезно —
 * jsdom не считает раскладку, а сломать всё равно может любой новый предок
 * с `contain`/`transform`/`filter`.
 */

const noop = (): void => {};

describe('Окна рендерятся порталом в document.body (баг 31.08)', () => {
  it('Sheet не остаётся в поддереве вызвавшего компонента', () => {
    const { container } = render(
      <Sheet open title="Действия" onClose={noop} closeLabel="Закрыть">
        <p>Открыть</p>
      </Sheet>,
    );
    // В точке вызова не осталось ничего.
    expect(container).toBeEmptyDOMElement();
    // А содержимое при этом на странице — и живёт прямо под body.
    const dialog = screen.getByRole('dialog', { name: 'Действия' });
    expect(dialog).toBeInTheDocument();
    expect(container.contains(dialog)).toBe(false);
    expect(dialog.closest('body')).toBe(document.body);
  });

  it('Modal не остаётся в поддереве вызвавшего компонента', () => {
    const { container } = render(
      <Modal open title="Удалить черновик" onClose={noop} closeLabel="Закрыть">
        <p>Точно удалить?</p>
      </Modal>,
    );
    expect(container).toBeEmptyDOMElement();
    expect(container.contains(screen.getByRole('dialog', { name: 'Удалить черновик' }))).toBe(false);
  });

  it('крестик Sheet закрывается даже из-под предка с contain: layout', async () => {
    const onClose = vi.fn();
    render(
      // Ровно та ловушка, что и в строке списка договоров: `container-type`
      // включает `contain: layout` и перехватывает `position: fixed` на себя.
      <div style={{ containerType: 'inline-size' }}>
        <Sheet open title="Действия" onClose={onClose} closeLabel="Закрыть">
          <p>Открыть</p>
        </Sheet>
      </div>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
