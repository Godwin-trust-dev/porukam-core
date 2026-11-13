import type { Meta, StoryObj } from '@storybook/react';
import { AcceptanceChecklist } from './AcceptanceChecklist';
import { EvidenceList } from './EvidenceList';
import { EvidenceUploader } from './EvidenceUploader';
import { StartConditions } from './StartConditions';
import { StoragePlashka } from './StoragePlashka';

/**
 * Витрина композиции DEV-11 (не отдельный экспортируемый компонент — сама
 * страница `StagePage.tsx` живёт в `web/`, Storybook её не видит): показывает
 * двухпанельную раскладку desktop (§7) — слева чек-лист + старт-условия,
 * справа доказательства + загрузка + плашка хранения.
 */
function DesktopLayout(): JSX.Element {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--pr-sp-5)', maxWidth: 1080 }}>
      <div style={{ display: 'grid', gap: 'var(--pr-sp-5)' }}>
        <div style={{ background: 'var(--pr-white)', border: '1px solid var(--pr-line)', borderRadius: 'var(--pr-r-lg)', padding: 'var(--pr-sp-5)' }}>
          <StartConditions
            title="Что нужно для старта"
            items={[
              { key: 'contract_signed', label: 'Договор подписан', state: 'met', linkRef: 'contract' },
              { key: 'materials', label: 'Материалы получены', state: 'met', sub: '5 из 5 позиций', linkRef: 'materials' },
              { key: 'access', label: 'Доступ к объекту', state: 'met' },
            ]}
            stateLabels={{ met: 'Готово', waiting: 'Ждём', na: 'Не требуется' }}
            openLabel="Открыть"
            onOpen={() => {}}
          />
        </div>
        <div style={{ background: 'var(--pr-white)', border: '1px solid var(--pr-line)', borderRadius: 'var(--pr-r-lg)', padding: 'var(--pr-sp-5)' }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 'var(--pr-fs-h3)', color: 'var(--pr-ink)' }}>Чек-лист сдачи</h3>
          <AcceptanceChecklist
            items={[
              { id: 'a', label: 'Плитка уложена по всей площади', optional: false, attachedLabel: 'приложено · 1' },
              { id: 'b', label: 'Швы затёрты', optional: false },
              { id: 'c', label: 'Мусор и упаковка вывезены', optional: true, optionalLabel: 'необязательно' },
            ]}
            attachLabel="＋ Приложить"
            onAttach={() => {}}
          />
        </div>
      </div>
      <div style={{ display: 'grid', gap: 'var(--pr-sp-5)' }}>
        <div style={{ background: 'var(--pr-white)', border: '1px solid var(--pr-line)', borderRadius: 'var(--pr-r-lg)', padding: 'var(--pr-sp-5)' }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 'var(--pr-fs-h3)', color: 'var(--pr-ink)' }}>Приложить доказательство</h3>
          <EvidenceUploader
            dropLabel="Перетащите файлы сюда"
            browseLabel="Выбрать файлы"
            bindLabel="Привязать к"
            bindHint="Привяжите к пункту — понятнее на приёмке"
            bindOptions={[{ id: 'stage', label: 'Этап целиком' }, { id: 'a', label: 'Плитка уложена по всей площади' }]}
            bindValue="stage"
            onBindChange={() => {}}
            onSelectFiles={() => {}}
            cameraStubText="Точная съёмка с метками — в приложении (скоро). Сейчас — веб-загрузка."
          />
        </div>
        <div style={{ background: 'var(--pr-white)', border: '1px solid var(--pr-line)', borderRadius: 'var(--pr-r-lg)', padding: 'var(--pr-sp-5)' }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 'var(--pr-fs-h3)', color: 'var(--pr-ink)' }}>Доказательства</h3>
          <EvidenceList
            items={[
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
            ]}
            emptyText="Пока ничего не приложено"
            onView={() => {}}
            onDelete={() => {}}
            deleteLabel="Удалить"
          />
        </div>
        <StoragePlashka
          tone="info"
          title="Оригинал остаётся у вас"
          text="Оригинал остаётся у вас (на вашем устройстве). Платформа хранит хеш, метку времени и миниатюру."
          connectLabel="Подключить Drive"
          onConnect={() => {}}
        />
      </div>
    </div>
  );
}

const meta: Meta<typeof DesktopLayout> = {
  title: 'Компоненты/StageSubmissionShowcase',
  component: DesktopLayout,
};
export default meta;
type Story = StoryObj<typeof DesktopLayout>;

export const DesktopTwoPanel: Story = { args: {} };
