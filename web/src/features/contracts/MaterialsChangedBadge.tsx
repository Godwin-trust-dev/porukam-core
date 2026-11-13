/**
 * Бейдж внимания «Материалы изменены контрагентом» (фронтовой хвост ADR-156;
 * отметка «просмотрено» — серверная, ADR-158).
 *
 * Вид — строка-хэйрлайн со статусом СЛОВОМ-цветом (`StatusWord`, как в
 * DEV-20_2 §2), не плашка и не рамка: карточка договора и так набрана
 * хэйрлайнами, ещё одна рамка внутри панели ломала бы ритм. Строка кликабельна
 * целиком — жест «перейти к материалам», он же снимает бейдж.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ContractRole, NegotiationStatus, RealTimelineEvent } from '@porukam/core';
import { Icon, StatusWord } from '@porukam/ui';
import {
  hasUnseenMaterialsChange,
  lastCounterpartyMaterialChange,
  markMaterialsSeen,
  maxSeenAt,
  readMaterialsSeenAt,
  subscribeMaterialsSeen,
  type MaterialsChangeFact,
} from './materialsChanged';
import { useMarkMaterialsSeen } from './realApi';
import styles from './MaterialsChangedBadge.module.css';

export interface MaterialsChangedBadgeState {
  visible: boolean;
  /** Этап, чьи материалы правили последними, — цель перехода (`#milestone-…`). */
  milestoneId: string | null;
  milestoneTitle: string | null;
  /** Отметить материалы просмотренными (клик по бейджу / открытие этапов):
   * оптимистично локально + `POST /contracts/{id}/materials-seen` (ADR-158). */
  markSeen: () => void;
}

/**
 * Признак «контрагент правил материалы, а я ещё не смотрел».
 *
 * Ограничение по статусу — то же, что у уведомления (ADR-156 §1): бейдж живёт
 * только на СОГЛАСОВАНИИ. В черновике вторая сторона договор ещё не видела, а
 * после подписания правок материалов не бывает вовсе (`_assert_editable`), и
 * старое событие черновика иначе висело бы значком внимания всю жизнь сделки.
 */
export function useMaterialsChangedBadge(params: {
  contractId: string;
  events: readonly RealTimelineEvent[] | undefined;
  negotiationStatus: NegotiationStatus;
  /** Ключ ЛОКАЛЬНОГО кэша отметки — активный профиль актёра. */
  viewerKey: string | null;
  viewerUserId: string | null;
  viewerRole: ContractRole | null;
  /** `contract.materials_seen_at` — серверная отметка МОЕЙ стороны (ADR-158),
   * источник правды: переживает смену устройства и приватное окно. */
  serverSeenAt: string | null;
}): MaterialsChangedBadgeState {
  const { contractId, events, negotiationStatus, viewerKey, viewerUserId, viewerRole, serverSeenAt } = params;
  const [localSeenAt, setLocalSeenAt] = useState<string | null>(() => readMaterialsSeenAt(contractId, viewerKey));
  // `mutate` у react-query стабилен между рендерами — берём именно его,
  // иначе `markSeen` пересоздавался бы на каждом рендере.
  const { mutate: markOnServer } = useMarkMaterialsSeen(contractId);

  // Смена договора/профиля — перечитываем локальный кэш; подписка держит в
  // курсе ВТОРОЙ бейдж (в «Обзоре» и в блоке материалов хук свой, факт —
  // общий), чтобы оба гасли одним кликом, не дожидаясь ответа сервера.
  useEffect(() => {
    setLocalSeenAt(readMaterialsSeenAt(contractId, viewerKey));
    return subscribeMaterialsSeen(() => setLocalSeenAt(readMaterialsSeenAt(contractId, viewerKey)));
  }, [contractId, viewerKey]);

  const fact: MaterialsChangeFact | null =
    negotiationStatus === 'under_review'
      ? lastCounterpartyMaterialChange(events, { userId: viewerUserId, role: viewerRole })
      : null;

  const factAt = fact?.at ?? null;
  const markSeen = useCallback(() => {
    if (!factAt) return;
    // Оптимистично гасим оба бейджа, затем отмечаем на сервере. Отказ сети не
    // разбираем: бейдж вернётся при следующей загрузке карточки — это мягче,
    // чем ошибка на жест «перейти к материалам».
    markMaterialsSeen(contractId, viewerKey, factAt);
    markOnServer({ seen_at: factAt });
  }, [contractId, viewerKey, factAt, markOnServer]);

  return {
    visible: hasUnseenMaterialsChange(fact, maxSeenAt(serverSeenAt, localSeenAt)),
    milestoneId: fact?.milestoneId ?? null,
    milestoneTitle: fact?.milestoneTitle ?? null,
    markSeen,
  };
}

export function MaterialsChangedBadge({
  label,
  hint,
  onOpen,
  testId = 'materials-changed-badge',
}: {
  label: string;
  hint?: string;
  onOpen: () => void;
  testId?: string;
}): JSX.Element {
  return (
    <button type="button" className={styles.row} onClick={onOpen} data-testid={testId}>
      <Icon name="wallet" size={16} />
      <StatusWord label={label} tone="amber" />
      {hint ? <span className={styles.hint}>{hint}</span> : null}
    </button>
  );
}
