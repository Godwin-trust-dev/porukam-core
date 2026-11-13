import type { ReactNode } from 'react';
import type { BadgeTone } from './Badge';
import { ListRow } from './ListRow';
import { StatusWord } from './StatusWord';
import styles from './SearchResultRow.module.css';

export interface SearchResultRowProps {
  /** Имя человека или название объединения — первая строка. */
  name: string;
  /** @хендл — ВТОРОЙ строкой, а не под именем в одной колонке с бейджем. */
  handle?: string | null;
  /** Фото/логотип; без него — инициалы на цветном круге (`Avatar`). */
  avatarSrc?: string;
  /** Готовый лид, если у вызывающего свой (логотип объединения). */
  avatar?: ReactNode;
  /** Довесок второй строки: город, тип объединения, число участников. */
  meta?: ReactNode;
  /** Статус СЛОВОМ-цветом в конце второй строки (видимость, политика входа). */
  statusLabel?: string;
  statusTone?: BadgeTone;
  /**
   * Длинный статус — ОТДЕЛЬНОЙ строкой под хендлом. «По подтверждению
   * администратора» в конце второй строки съедало у @хендла всю ширину на
   * 360px («@sa…»), а хендл — это адрес, по которому объединение находят.
   */
  statusOwnLine?: boolean;
  /** Третья строка — редкие пометки, когда статусов больше одного. */
  extra?: ReactNode;
  selected?: boolean;
  /** Строку видно, но выбрать нельзя (контакт без @хендла) — см. `ListRow.disabled`. */
  disabled?: boolean;
  onOpen: () => void;
  'data-testid'?: string;
}

/**
 * Строка результата поиска — ОДНА на все места, где ищут контрагента или
 * объединение: `/search`, список `/groups`, подсказка шага «Стороны» мастера.
 *
 * Замечание владельца 03.09: «при поиске контрагента выдаёт рамку, в ней
 * текст „По подтверждению администратора“ наезжает на хендл». Причина была в
 * раскладке: имя, @хендл и бейджи стояли в одной строке-обёртке и на 390px
 * накладывались. Здесь работает ритм доски A (`ListRow`): имя — первой
 * строкой, «@хендл · довесок» — второй, статус словом-цветом — в её конце,
 * и он не сжимается. Своей рамки у строки нет: плоскость и hairline даёт
 * `Surface`, в который список кладёт строки.
 */
export function SearchResultRow({
  name,
  handle,
  avatarSrc,
  avatar,
  meta,
  statusLabel,
  statusTone = 'neutral',
  statusOwnLine,
  extra,
  selected,
  disabled,
  onOpen,
  ...rest
}: SearchResultRowProps): JSX.Element {
  const statusNode = statusLabel ? <StatusWord label={statusLabel} tone={statusTone} /> : undefined;
  return (
    <ListRow
      avatar={avatar}
      avatarName={name}
      avatarHandle={handle ?? undefined}
      avatarSrc={avatarSrc}
      title={name}
      meta={
        handle || meta ? (
          <>
            {handle ? <span className={styles.handle}>{handle}</span> : null}
            {handle && meta ? ' · ' : null}
            {meta}
          </>
        ) : null
      }
      status={statusOwnLine ? undefined : statusNode}
      extra={
        statusOwnLine && statusNode ? (
          <span className={styles.statusLine}>
            {statusNode}
            {extra ? ' · ' : null}
            {extra}
          </span>
        ) : (
          extra
        )
      }
      selected={selected}
      disabled={disabled}
      ariaLabel={name}
      onOpen={onOpen}
      {...rest}
    />
  );
}
