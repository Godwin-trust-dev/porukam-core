import type { Meta, StoryObj } from '@storybook/react';
import { Button } from '../components/Button';
import { ContractPassport } from '../components/ContractPassport';
import { ContractTile } from '../components/ContractTile';
import { MilestoneList } from '../components/MilestoneList';
import { SummaryCard } from '../components/SummaryCard';
import { EmptyState } from '../components/States';
import { TextField } from '../components/Field';
import { CardGrid } from './CardGrid';
import { FormPane } from './FormPane';
import { MasterDetail } from './MasterDetail';
import { PassportLayout } from './PassportLayout';
import { RailLayout } from './RailLayout';
import { WorkArea } from './WorkArea';

/**
 * Примитивы десктоп-раскладки (DEV-19, ADR-099). Смотреть на приёмочных
 * ширинах тулбаром Viewport: 360 · 768 · 1023 · 1024 · 1440 — переключение
 * «стопка ↔ десктоп» обязано происходить между 1023 и 1024.
 */
const meta: Meta = {
  title: 'Раскладка/Примитивы',
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj;

const card: React.CSSProperties = {
  background: 'var(--pr-white)',
  border: '1px solid var(--pr-line)',
  borderRadius: 'var(--pr-r-lg)',
  padding: 'var(--pr-sp-5)',
};

function Row({ title, selected }: { title: string; selected?: boolean }): JSX.Element {
  return (
    <div
      style={{
        ...card,
        borderColor: selected ? 'var(--pr-amber-deep)' : 'var(--pr-line)',
        boxShadow: selected ? 'var(--pr-shadow-amber)' : 'none',
      }}
    >
      <strong>{title}</strong>
      <p style={{ margin: 0, color: 'var(--pr-text-2)', fontSize: 'var(--pr-fs-sm)' }}>Анна К. · Вы — заказчик</p>
    </div>
  );
}

const STAGES = [
  { id: '1', title: 'Демонтаж', statusLabel: 'принят', done: true, amountLabel: '40 000 ₽' },
  { id: '2', title: 'Черновые работы', statusLabel: 'принят', done: true, amountLabel: '40 000 ₽' },
  { id: '3', title: 'Чистовая отделка', statusLabel: 'на приёмке', current: true, amountLabel: '40 000 ₽' },
  { id: '4', title: 'Электрика', statusLabel: 'ожидает', amountLabel: '20 000 ₽' },
];

/** §2 — список слева, детали справа в одном экране; на узком детали не рендерятся вовсе. */
export const MasterDetailScreen: Story = {
  name: '§2 Master-detail',
  render: () => (
    <div style={{ padding: 'var(--pr-sp-6)' }}>
      <WorkArea>
        <MasterDetail
          detailLabel="Детали"
          list={
            <div style={{ display: 'grid', gap: 'var(--pr-sp-3)' }}>
              <Row title="Ремонт кухни" selected />
              <Row title="Логотип для кафе" />
              <Row title="Тексты для лендинга" />
            </div>
          }
          detail={() => (
            <div style={{ display: 'grid', gap: 'var(--pr-sp-4)' }}>
              <div style={card}>
                <h3 style={{ margin: 0 }}>Ремонт кухни</h3>
                <p style={{ margin: 0, color: 'var(--pr-text-2)' }}>Анна К. · Вы — заказчик · Услуга с этапами</p>
              </div>
              <MilestoneList title="Этапы" items={STAGES} countLabel="2 / 4" progressPct={50} nowLabel="сейчас" />
            </div>
          )}
        />
      </WorkArea>
    </div>
  ),
};

/** §3 — главный столбец + правый рейл; на узком рейл уходит вниз. */
export const DashboardRail: Story = {
  name: '§3 Мультиколонка + правый рейл',
  render: () => (
    <div style={{ padding: 'var(--pr-sp-6)' }}>
      <WorkArea>
        <RailLayout
          railLabel="Сводка"
          rail={
            <>
              <SummaryCard
                eyebrow="Деньги в активных сделках"
                values={['163 000 ₽']}
                stats={[
                  { label: 'Активные', value: '3' },
                  { label: 'Архив', value: '12' },
                ]}
              />
              <SummaryCard eyebrow="Профиль">
                <p style={{ margin: 0, fontWeight: 700 }}>Анна Кузнецова</p>
                <span style={{ color: 'var(--pr-text-2)' }}>@anna.k</span>
              </SummaryCard>
            </>
          }
        >
          <CardGrid>
            <ContractTile no="PR-1042" title="Ремонт кухни" status="in_progress" statusLabel="В работе" metaLabel="Анна К. · Вы — заказчик" amountLabel="120 000 ₽" payLabel="Платёж под защитой" onOpen={() => {}} />
            <ContractTile no="PR-1039" title="Логотип для кафе" status="signed" statusLabel="Подписан" metaLabel="Дмитрий В. · Вы — исполнитель" amountLabel="25 000 ₽" payLabel="Эскроу-холд" onOpen={() => {}} />
            <ContractTile no="PR-1051" title="Тексты для лендинга" status="in_progress" statusLabel="В работе" metaLabel="Sofia M. · Вы — исполнитель" amountLabel="18 000 ₽" payLabel="Наличный расчёт" onOpen={() => {}} />
          </CardGrid>
        </RailLayout>
      </WorkArea>
    </div>
  ),
};

/** §4 — липкий паспорт-рейл + широкое тело; на узком рейл становится шапкой. */
export const ContractCard: Story = {
  name: '§4 Паспорт-рейл + широкое тело',
  render: () => (
    <div style={{ padding: 'var(--pr-sp-6)' }}>
      <WorkArea>
        <PassportLayout
          passport={
            <ContractPassport
              no="PR-1042"
              title="Ремонт кухни"
              subtitle="Услуга с этапами"
              status="in_progress"
              statusLabel="В работе"
              rows={[
                { label: 'Заказчик', value: 'Анна К.', onOpen: () => {} },
                { label: 'Исполнитель', value: 'вы' },
                { label: 'Способ расчёта', value: 'Платёж под защитой' },
              ]}
              sum={{ amount: '120000.00', currency: 'RUB' }}
              sumNote="3 из 5 этапов · 80 000 ₽ принято"
              actions={
                <>
                  <Button variant="primary" block onClick={() => {}}>
                    Открыть приёмку
                  </Button>
                  <Button variant="secondary" block onClick={() => {}}>
                    Экспорт архива
                  </Button>
                </>
              }
            />
          }
        >
          <MilestoneList title="Этапы работ" items={STAGES} countLabel="2 / 4" progressPct={50} nowLabel="сейчас" />
        </PassportLayout>
      </WorkArea>
    </div>
  ),
};

/** §5 — форма по центру рабочей области, поля не разъезжаются. */
export const CenteredForm: Story = {
  name: '§5 Форма по центру',
  render: () => (
    <div style={{ padding: 'var(--pr-sp-6)' }}>
      <WorkArea>
        <FormPane>
          <div style={{ ...card, display: 'grid', gap: 'var(--pr-sp-4)' }}>
            <h3 style={{ margin: 0 }}>Что за договор?</h3>
            <TextField label="Название договора" value="Ремонт кухни" onChange={() => {}} />
            <TextField label="Сумма" value="120 000" onChange={() => {}} />
            <Button variant="primary" onClick={() => {}}>
              Далее
            </Button>
          </div>
        </FormPane>
      </WorkArea>
    </div>
  ),
};

/** §3 — пустое состояние: плотный блок ПО ЦЕНТРУ рабочей области, не полоса на весь монитор. */
export const CenteredEmptyState: Story = {
  name: '§3 Пустое состояние по центру',
  render: () => (
    <div style={{ padding: 'var(--pr-sp-6)' }}>
      <WorkArea>
        <EmptyState
          icon="deals"
          title="Пока нет активных договоров"
          text="Создайте договор или найдите исполнителя — здесь появятся ваши сделки в работе."
          actionLabel="Создать договор"
          onAction={() => {}}
        />
      </WorkArea>
    </div>
  ),
};
