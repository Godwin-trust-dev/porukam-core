import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PortfolioPhotoDto, PortfolioProjectDto } from '@porukam/core';
import { Badge, Button, Icon, Modal } from '@porukam/ui';
import { useFormatters } from '../../shared/formatters';
import styles from './ProjectView.module.css';

export const sphereKey = (code: string): string => `profile.portfolioSphere.${code}`;

/** Ссылка на вариант фото: `url` уже несёт `?v=`, размер — вторым параметром. */
export function photoSrc(url: string, size: 320 | 1280): string {
  return `${url}&size=${size}`;
}

/** Всё, что нужно просмотру работы: общая часть `PortfolioProjectDto`
 * (человек) и `GroupPortfolioProjectDto` (объединение, ADR-128). */
export interface ViewableProject {
  title: string;
  description: string;
  photos: PortfolioPhotoDto[];
  started_at: string | null;
  completed_at: string | null;
  location_label: string;
  /** Плоский код сферы человека (ADR-120). У объединения сфера каталожная —
   * её подпись приходит готовой строкой в `sphereLabel`. */
  sphere?: string;
  /** Только у человека: работа собрана из завершённого договора. */
  is_verified?: boolean;
}

/** Период выполнения работы: «начало — завершение» либо «Завершено {дата}». */
export function useProjectPeriod(): (p: Pick<PortfolioProjectDto, 'started_at' | 'completed_at'>) => string | null {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  return (p) => {
    if (!p.completed_at) return null;
    if (p.started_at) return t('profile.portfolioPeriod', { from: formatDate(p.started_at), to: formatDate(p.completed_at) });
    return t('profile.portfolioCompletedOn', { date: formatDate(p.completed_at) });
  };
}

/**
 * Просмотр работы (ADR-120): галерея фото с листанием, описание целиком,
 * период, город, сфера. Открывается с карточки репутации (гость и владелец),
 * со страницы /me/portfolio и с витрины объединения (ADR-128) — один
 * компонент, без действий редактирования.
 */
export function ProjectViewModal({
  project,
  sphereLabel,
  onClose,
}: {
  project: ViewableProject | null;
  /** Готовая подпись сферы — для объединения (код каталога, не enum). */
  sphereLabel?: string;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const period = useProjectPeriod();
  const [index, setIndex] = useState(0);
  // Сфера: у объединения — готовая подпись, у человека — ключ плоского enum.
  const sphereText = sphereLabel ?? (project?.sphere ? t(sphereKey(project.sphere)) : null);
  const photos = project?.photos ?? [];
  const current = photos[Math.min(index, Math.max(photos.length - 1, 0))];

  return (
    <Modal open={project !== null} title={project?.title ?? ''} onClose={onClose} closeLabel={t('common.close')}>
      {project ? (
        <div className={styles.wrap} data-testid="project-view">
          {current ? (
            <figure className={styles.gallery}>
              <img src={photoSrc(current.url, 1280)} alt={project.title} className={styles.photo} data-testid="project-view-photo" />
              {photos.length > 1 ? (
                <figcaption className={styles.nav}>
                  <Button size="sm" variant="ghost" aria-label={t('common.back')} onClick={() => setIndex((i) => (i - 1 + photos.length) % photos.length)}>
                    <Icon name="back" size={16} directional />
                  </Button>
                  <span>{t('profile.portfolioPhotoOf', { n: index + 1, total: photos.length })}</span>
                  <Button size="sm" variant="ghost" aria-label={t('common.details')} onClick={() => setIndex((i) => (i + 1) % photos.length)}>
                    <Icon name="chevron-down" size={16} style={{ transform: 'rotate(-90deg)' }} />
                  </Button>
                </figcaption>
              ) : null}
              {photos.length > 1 ? (
                <div className={styles.thumbs}>
                  {photos.map((p, i) => (
                    <button
                      key={p.id}
                      type="button"
                      className={`${styles.thumb} ${i === index ? styles.thumbActive : ''}`}
                      onClick={() => setIndex(i)}
                      aria-label={t('profile.portfolioPhotoOf', { n: i + 1, total: photos.length })}
                    >
                      <img src={photoSrc(p.url, 320)} alt="" />
                    </button>
                  ))}
                </div>
              ) : null}
            </figure>
          ) : null}
          <div className={styles.meta}>
            {sphereText ? <Badge tone="neutral">{sphereText}</Badge> : null}
            {project.is_verified ? <Badge tone="green">{t('profile.portfolioVerified')}</Badge> : null}
            {period(project) ? <span data-testid="project-view-period">{period(project)}</span> : null}
            {project.location_label ? <span>{project.location_label}</span> : null}
          </div>
          {project.description ? <p className={styles.description} data-testid="project-view-description">{project.description}</p> : null}
        </div>
      ) : null}
    </Modal>
  );
}
