/**
 * Мок-стор приёмки этапа (DEV-04). Отдельная от contractsDb проекция — DEV-04
 * работает с фактом СДАЧИ/ПРИЁМКИ этапа в исполнении, не с деревом этапов Ф2
 * договорного контура. Мутирует только через accept/return; сдача (submit)
 * исполнителем — вне скоупа этого экрана (§10).
 */
import type { AcceptanceRemark, AcceptanceState, MilestoneAcceptance } from '@porukam/core';
import { MockError } from './contractsDb';

const RUB = (amount: string) => ({ amount, currency: 'RUB' });

function seed(): MilestoneAcceptance[] {
  return [
    {
      contractId: 'c-9001',
      milestoneId: 'ms-9001',
      state: 'pending',
      stage: 'Укладка ламината, 42 м²',
      sum: RUB('63000.00'),
      counterparty: 'Мастер Ремонт (@masterremont)',
      submitted: true,
      files: [
        { id: 'af-1', name: 'Готовый пол, комната 1.jpg', kind: 'image', src: 'https://placehold.co/480x360' },
        { id: 'af-2', name: 'Готовый пол, комната 2.jpg', kind: 'image', src: 'https://placehold.co/480x360' },
        { id: 'af-3', name: 'Акт расхода материалов.pdf', kind: 'doc' },
      ],
      contractorChecklistDone: true,
      checklist: [
        { id: 'ci-1', label: 'Ламинат уложен по всей площади' },
        { id: 'ci-2', label: 'Плинтус установлен' },
        { id: 'ci-3', label: 'Мусор и упаковка вывезены' },
      ],
      timer: { hoursLeft: 42 },
      planned: null,
      remarks: [],
    },
    {
      contractId: 'c-9002',
      milestoneId: 'ms-9002',
      state: 'waiting',
      stage: 'Поклейка обоев, комната 2',
      sum: RUB('14000.00'),
      counterparty: 'Николай Гром (@grom_master)',
      submitted: false,
      files: [],
      contractorChecklistDone: false,
      checklist: [
        { id: 'ci-4', label: 'Стены поклеены без пузырей и стыков внахлёст' },
        { id: 'ci-5', label: 'Углы и откосы проклеены' },
      ],
      timer: null,
      planned: { daysLeft: 2 },
      remarks: [],
    },
    {
      contractId: 'c-9003',
      milestoneId: 'ms-9003',
      state: 'auto_accepted',
      stage: 'Демонтаж старого покрытия',
      sum: RUB('9000.00'),
      counterparty: 'Дмитрий Косяк (@d_kosyak)',
      submitted: true,
      files: [{ id: 'af-4', name: 'Демонтаж завершён.jpg', kind: 'image', src: 'https://placehold.co/480x360' }],
      contractorChecklistDone: true,
      checklist: [{ id: 'ci-6', label: 'Старое покрытие снято и вывезено' }],
      timer: null,
      planned: null,
      remarks: [],
    },
  ];
}

let items: MilestoneAcceptance[] = seed();

export function resetAcceptance(): void {
  items = seed();
}

function find(contractId: string, milestoneId: string): MilestoneAcceptance {
  const m = items.find((x) => x.contractId === contractId && x.milestoneId === milestoneId);
  if (!m) throw new MockError(404, 'not_found', 'Этап не найден.');
  return m;
}

export function getMilestoneAcceptance(contractId: string, milestoneId: string): MilestoneAcceptance {
  return find(contractId, milestoneId);
}

function assertDecidable(m: MilestoneAcceptance): void {
  const decided: AcceptanceState[] = ['accepted', 'auto_accepted', 'returned'];
  if (decided.includes(m.state)) {
    throw new MockError(409, 'milestone_already_accepted', 'Решение по этапу уже принято.');
  }
  if (m.state === 'waiting') {
    throw new MockError(409, 'invalid_state_transition', 'Этап ещё не сдан исполнителем.');
  }
}

export function acceptMilestone(contractId: string, milestoneId: string): MilestoneAcceptance {
  const m = find(contractId, milestoneId);
  assertDecidable(m);
  m.state = 'accepted';
  return m;
}

export function returnMilestone(contractId: string, milestoneId: string, remarks: AcceptanceRemark[]): MilestoneAcceptance {
  const m = find(contractId, milestoneId);
  assertDecidable(m);
  const valid = remarks.filter((r) => r.itemId && r.note?.trim());
  if (valid.length === 0) {
    throw new MockError(422, 'remark_item_required', 'Отметьте хотя бы один пункт замечанием с описанием.');
  }
  m.state = 'returned';
  m.remarks = valid;
  return m;
}
