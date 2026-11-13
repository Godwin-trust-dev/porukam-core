import { useTranslation } from 'react-i18next';
import type { RealEvidence } from '@porukam/core';
import { Button, Icon } from '@porukam/ui';
import { useEvidenceDetails, useEvidenceThumbnail } from './api';
import styles from './DisputeFeedAttachments.module.css';

/** Вложение пункта ленты: id всегда есть, метаданные — не всегда (лента спора
 * отдаёт только идентификаторы, имена дотягиваются отдельными запросами). */
export interface DisputeAttachment {
  id: string;
  meta: RealEvidence | undefined;
}

export interface DisputeFeedAttachmentsProps {
  ids: string[];
  /** `id` → метаданные из `GET /disputes/{id}/evidence` и
   * `GET /milestones/{id}/evidence` (второй источник — доказательства, с
   * которых спор открыли: у них `dispute_id` пустой). */
  meta: Map<string, RealEvidence>;
  /** Списковые источники метаданных ещё грузятся — поштучный добор не начинаем,
   * иначе на первую отрисовку ушёл бы запрос на каждое вложение. */
  metaPending?: boolean;
  /** `src` — уже загруженная плиткой миниатюра: страница не тянет её второй раз. */
  onOpen: (item: { id: string; name: string; src?: string }) => void;
  onDownload: (item: { id: string; name: string }) => void;
  testId?: string;
}

function isImage(meta: RealEvidence | undefined): boolean {
  return !!meta && meta.mime_type.startsWith('image/');
}

/**
 * Вложения пункта ленты разногласия (замечание владельца 05.09: «мне
 * ответили, а я не могу посмотреть фото»).
 *
 * Картинки — сеткой миниатюр (на 360 три в ряд), тап открывает просмотрщик со
 * «Скачать»; остальные файлы — строкой с именем и кнопкой скачивания:
 * миниатюры у них нет, и квадрат с иконкой сообщал бы меньше, чем имя файла.
 * Метаданные могут не прийти (файл вне двух известных источников) — тогда
 * файл всё равно скачиваем по id, а не прячем.
 */
export function DisputeFeedAttachments({ ids, meta, metaPending, onOpen, onDownload, testId }: DisputeFeedAttachmentsProps): JSX.Element | null {
  const { t } = useTranslation();
  // Чего нет в двух списковых источниках — добираем поштучно `GET /evidence/{id}`
  // (иначе вложения гарантийной претензии остались бы без имени и типа).
  const unknownIds = metaPending ? [] : ids.filter((id) => !meta.has(id));
  const details = useEvidenceDetails(unknownIds);
  if (ids.length === 0) return null;

  const resolved = new Map(meta);
  unknownIds.forEach((id, i) => {
    const data = details[i]?.data;
    if (data) resolved.set(id, data);
  });
  const items: DisputeAttachment[] = ids.map((id) => ({ id, meta: resolved.get(id) }));
  const images = items.filter((it) => isImage(it.meta));
  const files = items.filter((it) => !isImage(it.meta));
  const nameOf = (it: DisputeAttachment) => it.meta?.file_name || t('dispute.evidenceUnnamed');

  return (
    <div className={styles.wrap} data-testid={testId}>
      {images.length > 0 ? (
        <ul className={styles.grid}>
          {images.map((it) => (
            <li key={it.id}>
              <AttachmentTile item={it} name={nameOf(it)} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      ) : null}
      {files.length > 0 ? (
        <ul className={styles.files}>
          {files.map((it) => (
            <li key={it.id} className={styles.fileRow} data-testid="dispute-feed-file">
              <Icon name="attach" size={20} className={styles.fileIcon} />
              <div className={styles.fileMain}>
                <p className={styles.fileName}>{nameOf(it)}</p>
                {/* Пояснение автора, данное при загрузке (решение владельца
                    05.09): в споре оно нужнее всего — «что тут снято» читает
                    вторая сторона, а не тот, кто снимал. */}
                {it.meta?.description ? (
                  <p className={styles.fileDescription} data-testid="dispute-feed-description">
                    {it.meta.description}
                  </p>
                ) : null}
              </div>
              <Button variant="ghost" size="sm" onClick={() => onDownload({ id: it.id, name: nameOf(it) })}>
                {t('dispute.evidenceDownload')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Отдельный компонент — ради собственного запроса миниатюры на плитку:
 * `has_thumbnail: false` значит, что встроенной миниатюры нет, и дёргать
 * `GET /evidence/{id}/thumbnail` за 404 незачем (`EvidenceThumbnailView`
 * докстринг: миниатюра не подделывается). */
function AttachmentTile({
  item,
  name,
  onOpen,
}: {
  item: DisputeAttachment;
  name: string;
  onOpen: (i: { id: string; name: string; src?: string }) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const thumb = useEvidenceThumbnail(item.id, item.meta?.has_thumbnail === true);
  return (
    <button
      type="button"
      className={styles.tile}
      onClick={() => onOpen({ id: item.id, name, src: thumb.data })}
      aria-label={t('dispute.evidenceOpen', { name })}
      data-testid="dispute-feed-thumb"
    >
      <span className={styles.tileBox}>
        {thumb.data ? <img src={thumb.data} alt="" className={styles.tileImg} /> : <Icon name="camera" size={24} />}
      </span>
      <span className={styles.tileName}>{name}</span>
      {item.meta?.description ? (
        <span className={styles.tileDescription} data-testid="dispute-feed-description">
          {item.meta.description}
        </span>
      ) : null}
    </button>
  );
}
