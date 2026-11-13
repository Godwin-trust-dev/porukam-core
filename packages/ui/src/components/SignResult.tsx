import type { ReactNode } from 'react';
import styles from './SignResult.module.css';

export interface SignResultProps {
  /** «🔒 v · hash · дата» — как есть, механику церемонии не трогаем (DEV-16b §1). */
  chip: ReactNode;
  /** Только на разноязычной сделке (DEV-16b §0.6) — «Официальный текст — English». */
  languageNote?: string;
}

/**
 * Итог подписи (DEV-16b §3/§6) — передаётся в `Ceremony.chip`, не меняет саму церемонию.
 * Языковая строка — только `is_cross_language`; слово «канон» здесь не звучит.
 */
export function SignResult({ chip, languageNote }: SignResultProps): JSX.Element {
  return (
    <div className={styles.wrap}>
      <div>{chip}</div>
      {languageNote ? <p className={styles.note}>{languageNote}</p> : null}
    </div>
  );
}
