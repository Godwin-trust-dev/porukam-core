/**
 * Фирменные иконки «По рукам» (marketing/Po_Rukam_UI_Icons.html + `globe` DEV-16a,
 * + `chevron-down` DEV-17 §1 — шеврон селектов/раскрытий).
 * Единый каркас: сетка 24, stroke 1.8, currentColor.
 * Акценты НЕ хардкодятся hex — искра/галка через токены
 * (var(--pr-amber-deep) / var(--pr-green)).
 */
import type { ReactNode } from 'react';

const S = {
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};
const SPARK = 'var(--pr-amber-deep)';
const GREEN = 'var(--pr-green)';

export const ICON_PATHS = {
  // ── Навигация ──
  home: (
    <g {...S}>
      <path d="M4 11.3L12 4l8 7.3" />
      <path d="M6 10.2V20h12V10.2" />
      <path d="M10 20v-5.2h4V20" />
    </g>
  ),
  search: (
    <g {...S}>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l4.6 4.6" />
    </g>
  ),
  deals: (
    <>
      <g {...S}>
        <rect x="3.5" y="7.5" width="17" height="12" rx="2.3" />
        <path d="M8.5 7.5V6a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v1.5" />
        <path d="M3.5 12.6h17" />
      </g>
      <path
        d="M12 10.7 L12.532 12.068 L13.9 12.6 L12.532 13.132 L12 14.5 L11.468 13.132 L10.1 12.6 L11.468 12.068 Z"
        fill={SPARK}
      />
    </>
  ),
  chat: (
    <g {...S}>
      <path d="M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9l-3.6 3v-3H6.5a2 2 0 0 1-2-2z" />
    </g>
  ),
  bell: (
    <g {...S}>
      <path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 3.8 1.4 5.3 2 6H4.5c.6-.7 2-2.2 2-6z" />
      <path d="M9.8 20a2.3 2.3 0 0 0 4.4 0" />
    </g>
  ),
  profile: (
    <g {...S}>
      <circle cx="12" cy="8.4" r="3.6" />
      <path d="M5.5 19.6c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" />
    </g>
  ),
  /* Книга контактов — тот же каркас, что у `profile`: корешок с закладками
     слева, человек на развороте. Открывает справочник сохранённых контактов
     (шаг «Стороны» мастера, решение владельца 05.09). */
  contacts: (
    <g {...S}>
      <path d="M7.2 4h9.3a1.8 1.8 0 0 1 1.8 1.8v12.4a1.8 1.8 0 0 1-1.8 1.8H7.2z" />
      <path d="M7.2 4v16" />
      <path d="M4.6 8h2.6M4.6 12h2.6M4.6 16h2.6" />
      <circle cx="12.8" cy="10.4" r="1.9" />
      <path d="M9.8 16.3c0-1.6 1.4-2.7 3-2.7s3 1.1 3 2.7" />
    </g>
  ),

  // ── Действия ──
  plus: (
    <g {...S}>
      <path d="M12 5v14M5 12h14" />
    </g>
  ),
  filter: (
    <g {...S}>
      <path d="M4 6h16M7 12h10M10 18h4" />
    </g>
  ),
  sort: (
    <g {...S}>
      <path d="M4 7h10M4 12h7M4 17h4" />
      <path d="M17.5 8v9M17.5 17l2.4-2.4M17.5 17l-2.4-2.4" />
    </g>
  ),
  back: (
    <g {...S}>
      <path d="M14.5 5.5l-6.5 6.5 6.5 6.5" />
    </g>
  ),
  // DEV-17 §1: шеврон селекта (свой, вместо системного у нативного <select>).
  'chevron-down': (
    <g {...S}>
      <path d="M5.5 9.5l6.5 6.5 6.5-6.5" />
    </g>
  ),
  close: (
    <g {...S}>
      <path d="M6 6l12 12M18 6L6 18" />
    </g>
  ),
  // Корзина — удаление того, что ещё МОЖНО удалить (черновик доказательства
  // до сдачи этапа, ADR-160). Крестик остаётся «закрыть», не «удалить».
  trash: (
    <g {...S}>
      <path d="M4.5 6.8h15" />
      <path d="M9.5 6.8V5.4a1.6 1.6 0 0 1 1.6-1.6h1.8a1.6 1.6 0 0 1 1.6 1.6v1.4" />
      <path d="M6.6 6.8l.9 11.5a1.9 1.9 0 0 0 1.9 1.7h5.2a1.9 1.9 0 0 0 1.9-1.7l.9-11.5" />
      <path d="M10.4 10.4v6M13.6 10.4v6" />
    </g>
  ),
  copy: (
    <g {...S}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </g>
  ),
  // «i» в круге — строка «Что такое «По рукам»» в профиле (финал доска A).
  info: (
    <g {...S}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </g>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  edit: (
    <g {...S}>
      <path d="M15.4 5.2l3.4 3.4" />
      <path d="M5 19.4l-.9.3.4-3.6L15 5.6a1.9 1.9 0 0 1 2.7 0l.7.7a1.9 1.9 0 0 1 0 2.7L8.3 19.7z" />
    </g>
  ),
  share: (
    <g {...S}>
      <circle cx="6" cy="12" r="2.4" />
      <circle cx="17" cy="6" r="2.4" />
      <circle cx="17" cy="18" r="2.4" />
      <path d="M8.1 10.9l6.8-3.9M8.1 13.1l6.8 3.9" />
    </g>
  ),
  attach: (
    <g {...S}>
      <path d="M18 8.6l-7.7 7.7a3.1 3.1 0 0 1-4.4-4.4l7.8-7.8a2.1 2.1 0 0 1 3 3l-7.8 7.8a1 1 0 0 1-1.5-1.4l7-7" />
    </g>
  ),
  calendar: (
    <g {...S}>
      <rect x="4" y="5.5" width="16" height="15" rx="2.2" />
      <path d="M4 9.6h16M8.5 3.5v4M15.5 3.5v4" />
    </g>
  ),
  camera: (
    <g {...S}>
      <path d="M4 8.6A1.8 1.8 0 0 1 5.8 6.8h2L9 5h6l1.2 1.8h2A1.8 1.8 0 0 1 20 8.6v8.8A1.8 1.8 0 0 1 18.2 19H5.8A1.8 1.8 0 0 1 4 17.4z" />
      <circle cx="12" cy="13" r="3.3" />
    </g>
  ),
  settings: (
    <g {...S}>
      <path d="M4 7.5h8M16 7.5h4" />
      <circle cx="14" cy="7.5" r="2.1" />
      <path d="M4 16.5h4M12 16.5h8" />
      <circle cx="10" cy="16.5" r="2.1" />
    </g>
  ),

  // ── Этапы и сделка ──
  stages: (
    <g {...S}>
      <circle cx="6" cy="6.5" r="1.9" />
      <circle cx="6" cy="12" r="1.9" />
      <circle cx="6" cy="17.5" r="1.9" />
      <path d="M6 8.4v1.7M6 13.9v1.7" />
      <path d="M10 6.5h9M10 12h9M10 17.5h6" />
    </g>
  ),
  'stage-pay': (
    <>
      <g {...S}>
        <ellipse cx="12" cy="6.8" rx="6" ry="2.4" />
        <path d="M6 6.8v3.9c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4V6.8" />
        <path d="M6 10.7v3.9c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4v-3.9" />
      </g>
      <path
        d="M19 15.5 L19.532 16.868 L20.9 17.4 L19.532 17.932 L19 19.3 L18.468 17.932 L17.1 17.4 L18.468 16.868 Z"
        fill={SPARK}
      />
    </>
  ),
  progress: (
    <>
      <g {...S}>
        <rect x="3.5" y="9.4" width="17" height="5.2" rx="2.6" />
        <path d="M9 9.4v5.2M14.5 9.4v5.2" />
      </g>
      <rect x="3.5" y="9.4" width="5.5" height="5.2" rx="2.6" fill={GREEN} stroke="none" opacity="0.9" />
    </>
  ),
  milestone: (
    <>
      <g {...S}>
        <path d="M6 20V4" />
        <path d="M6 5.4h10l-2.2 3 2.2 3H6" />
      </g>
      <g fill="none" stroke={GREEN} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 6.2l1.1 1.1 2-2.1" />
      </g>
    </>
  ),
  contract: (
    <g {...S}>
      <path d="M6.5 3.5h7.2L18 7.8V20.5H6.5z" />
      <path d="M13.4 3.6v4.3H18" />
      <path d="M9 12h6M9 15h6M9 18h3.5" />
    </g>
  ),
  checklist: (
    <>
      <g {...S}>
        <rect x="5.5" y="4" width="13" height="16" rx="2" />
        <path d="M9 4.4V3.2h6v1.2" />
        <path d="M13.4 9.6h2.6M13.4 14.8h2.6" />
      </g>
      <g fill="none" stroke={GREEN} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
        <path d="M8.4 9.2l1.2 1.2 2-2M8.4 14.4l1.2 1.2 2-2" />
      </g>
    </>
  ),
  sealed: (
    <>
      <g {...S}>
        <circle cx="12" cy="12" r="8.2" />
        <path d="M8 12.4l2.6 2.6L16 9.6" />
      </g>
      <path
        d="M18.2 3.7 L18.956 5.644 L20.9 6.4 L18.956 7.156 L18.2 9.1 L17.444 7.156 L15.5 6.4 L17.444 5.644 Z"
        fill={SPARK}
      />
    </>
  ),

  // ── Деньги и защита ──
  wallet: (
    <g {...S}>
      <path d="M4 8a2 2 0 0 1 2-2h11a1.5 1.5 0 0 1 1.5 1.5V8" />
      <rect x="4" y="8" width="16.5" height="10.5" rx="2.2" />
      <path d="M20.5 12h-3.4a1.6 1.6 0 0 0 0 3.2h3.4" />
    </g>
  ),
  'pay-protected': (
    <g {...S}>
      <circle cx="12" cy="12" r="7.6" />
      <path d="M10 8.4h2.6a2.1 2.1 0 0 1 0 4.2H10M10 8.4v8M9 11.2h4.4" />
    </g>
  ),
  receipt: (
    <g {...S}>
      <path d="M6 3.5h12v17l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3z" />
      <path d="M9 8h6M9 11.5h6M9 15h3.5" />
    </g>
  ),
  shield: (
    <g {...S}>
      <path d="M12 3.2l6.4 2.4v5.1c0 4.2-2.8 6.6-6.4 8-3.6-1.4-6.4-3.8-6.4-8V5.6z" />
      <path d="M9 12l2.2 2.2L15.4 10" />
    </g>
  ),
  warranty: (
    <g {...S}>
      <path d="M12 3.2l6.4 2.4v5.1c0 4.2-2.8 6.6-6.4 8-3.6-1.4-6.4-3.8-6.4-8V5.6z" />
      <circle cx="12" cy="11" r="2.9" />
      <path d="M12 9.2V11l1.3.9" />
    </g>
  ),

  // ── Доверие и статусы ──
  reputation: (
    <>
      <g {...S}>
        <path d="M5.5 19.5V13M10 19.5V9M14.5 19.5V11M19 19.5V6.5" />
        <path d="M4 19.7h16" />
      </g>
      <path
        d="M18.8 3.7 L19.556 5.644 L21.5 6.4 L19.556 7.156 L18.8 9.1 L18.044 7.156 L16.1 6.4 L18.044 5.644 Z"
        fill={SPARK}
      />
    </>
  ),
  verified: (
    <>
      <g {...S}>
        <circle cx="11" cy="9" r="3.2" />
        <path d="M5.4 19.2c0-3.1 2.5-5.2 5.6-5.2 1.2 0 2.3.3 3.2.9" />
      </g>
      <g fill="none" stroke={GREEN} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="16.8" cy="16.8" r="3.4" />
        <path d="M15.4 16.9l1 1 1.8-1.9" />
      </g>
    </>
  ),
  'in-progress': (
    <g {...S}>
      <circle cx="12" cy="12" r="7.6" />
      <path d="M12 7.6V12l3.2 2" />
    </g>
  ),
  dispute: (
    <g {...S}>
      <path d="M12 4v15M7 19h10M6 8h12M12 5.4L6 8M12 5.4L18 8" />
      <path d="M4 12.4L6 8l2 4.4a2 2 0 0 1-4 0z" />
      <path d="M16 12.4L18 8l2 4.4a2 2 0 0 1-4 0z" />
    </g>
  ),
  symmetric: (
    <g {...S}>
      <circle cx="10" cy="10" r="5" />
      <path d="M13.7 13.7l4 4" />
      <path d="M8 10h4M10 8v4" />
    </g>
  ),
  visible: (
    <>
      <g {...S}>
        <path d="M3.2 12c2-3.6 5.2-5.6 8.8-5.6S18.8 8.4 20.8 12c-2 3.6-5.2 5.6-8.8 5.6S5.2 15.6 3.2 12z" />
        <circle cx="12" cy="12" r="2.6" />
      </g>
      <path d="M18.8 3.5 L19.5 5.3 L21.3 6 L19.5 6.7 L18.8 8.5 L18.1 6.7 L16.3 6 L18.1 5.3 Z" fill={SPARK} />
    </>
  ),
  discuss: (
    <>
      <g {...S}>
        <path d="M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9l-3.5 3v-3H6.5a2 2 0 0 1-2-2z" />
      </g>
      <path d="M17.6 3.1 L18.3 4.9 L20.1 5.6 L18.3 6.3 L17.6 8.1 L16.9 6.3 L15.1 5.6 L16.9 4.9 Z" fill={SPARK} />
    </>
  ),

  // ── PWA (DEV-15) ──
  install: (
    <g {...S}>
      <path d="M12 4v10" />
      <path d="M8 10.5L12 14.5 16 10.5" />
      <path d="M5 16.5v2A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-2" />
    </g>
  ),
  offline: (
    <g {...S}>
      <path d="M6.5 10.5a11 11 0 0 1 6-2.7" />
      <path d="M12.8 7.8a11 11 0 0 1 5.7 2.7" />
      <path d="M9.3 14a6 6 0 0 1 3.4-1.6" />
      <path d="M15.3 14a6 6 0 0 0-1.4-1.1" />
      <circle cx="12" cy="18" r="1.3" fill="currentColor" stroke="none" />
      <path d="M4 4l16 16" />
    </g>
  ),
  refresh: (
    <g {...S}>
      <path d="M19 6.5A8 8 0 1 0 20.5 12" />
      <path d="M19 3v4.5h-4.5" />
    </g>
  ),
  // ── DEV-16a · переключатель языка (без флагов стран — язык ≠ страна) ──
  globe: (
    <g {...S}>
      <circle cx="12" cy="12" r="8.5" />
      <ellipse cx="12" cy="12" rx="3.6" ry="8.5" />
      <path d="M3.5 12h17" />
      <path d="M5 7.3h14" />
      <path d="M5 16.7h14" />
    </g>
  ),
  // ── Выход из аккаунта (замечание владельца 07.09: кнопки «Выйти» нигде не
  //    было) — стрелка из «двери» вправо, тот же каркас 24/1.8/currentColor. ──
  logout: (
    <g {...S}>
      <path d="M14.5 4.5H6.8A1.8 1.8 0 0 0 5 6.3v11.4a1.8 1.8 0 0 0 1.8 1.8h7.7" />
      <path d="M15.6 8.6L19 12l-3.4 3.4" />
      <path d="M19 12h-8.6" />
    </g>
  ),
  // ── DEV-20 §5 · композер чата: отправка ──
  send: (
    <g {...S}>
      <path d="M4.4 11.9L19.6 4.9 13.2 19.4l-2.4-5.6-6.4-1.9z" />
      <path d="M10.8 13.8L19.6 4.9" />
    </g>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICON_PATHS;
export const ICON_NAMES = Object.keys(ICON_PATHS) as IconName[];
