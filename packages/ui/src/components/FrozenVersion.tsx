import { formatDateTime } from '@porukam/core';
import { Icon } from './Icon';
import { LtrText } from './LtrText';
import styles from './FrozenVersion.module.css';

export interface FrozenVersionLinks {
  stagesLabel: string;
  onStages: () => void;
  checklistsLabel: string;
  onChecklists: () => void;
  materialsLabel: string;
  onMaterials: () => void;
}

export interface FrozenVersionProps {
  title: string;
  /** Человекочитаемое имя версии (напр. «Версия от 31 июля 2026»). */
  version: string;
  /** Уже укороченный хеш для показа (не «простыня») — считает страница. */
  hashShort: string;
  hashLabel: string;
  tsaTime: string;
  tsaLabel: string;
  links: FrozenVersionLinks;
}

/** «Что вы подписываете» (DEV-05 §2) — версия + hash, ссылки на состав. Метка-замок. */
export function FrozenVersion({ title, version, hashShort, hashLabel, tsaTime, tsaLabel, links }: FrozenVersionProps): JSX.Element {
  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <Icon name="sealed" size={20} className={styles.lock} />
        <h3 className={styles.title}>{title}</h3>
      </div>
      <p className={styles.version}>{version}</p>
      <div className={styles.row}>
        <span className={styles.label}>{hashLabel}</span>
        <LtrText as="span" className={styles.hash} data-testid="frozen-version-hash">
          {hashShort}
        </LtrText>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>{tsaLabel}</span>
        <LtrText as="span" className={styles.value} data-testid="frozen-version-tsa">
          {formatDateTime(tsaTime, undefined, undefined, { legal: true })}
        </LtrText>
      </div>
      <div className={styles.links}>
        <button type="button" className={styles.link} onClick={links.onStages}>
          {links.stagesLabel}
        </button>
        <button type="button" className={styles.link} onClick={links.onChecklists}>
          {links.checklistsLabel}
        </button>
        <button type="button" className={styles.link} onClick={links.onMaterials}>
          {links.materialsLabel}
        </button>
      </div>
    </div>
  );
}
