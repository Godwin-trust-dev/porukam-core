import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, type PortfolioProjectDto } from '@porukam/core';
import { Badge, Button, Card, Callout, EmptyState, ErrorState, FieldHelp, Icon, Skeleton } from '@porukam/ui';
import { useCurrentUser } from '../features/auth/useAuth';
import {
  useAddProjectPhoto,
  useCreatePortfolioProject,
  usePortfolioProjects,
  usePublishProject,
  useRemoveProjectPhotoItem,
  useSetPrimaryProjectPhoto,
  useUpdatePortfolioProject,
} from '../features/portfolio/api';
import { ProjectFormModal, photoErrorText, toApiError } from '../features/portfolio/ProjectFormModal';
import { ProjectViewModal, photoSrc, sphereKey, useProjectPeriod } from '../features/portfolio/ProjectView';
import { apiErrorText } from '../shared/apiErrorText';
import styles from './PortfolioPage.module.css';

export const MAX_PHOTOS = 5;
export { sphereKey };

/**
 * `/me/portfolio` (ADR-115 → ADR-120): проекты-работы с галереей до 5 фото
 * (первое — основное), редактирование, обязательная дата завершения, город,
 * просторное описание. Публикация — отдельным действием (проект из договора
 * может требовать согласия второй стороны — ошибка бэка человекочитаема).
 */
export function PortfolioPage(): JSX.Element {
  const { t } = useTranslation();
  const { data: me } = useCurrentUser();
  const profileId = me?.profiles.find((p) => p.kind === 'person')?.id ?? me?.profiles[0]?.id;
  const { data, isPending, error, refetch } = usePortfolioProjects(profileId);
  const create = useCreatePortfolioProject(profileId);
  const update = useUpdatePortfolioProject(profileId);
  const addPhoto = useAddProjectPhoto(profileId);
  const removePhoto = useRemoveProjectPhotoItem(profileId);
  const setPrimary = useSetPrimaryProjectPhoto(profileId);
  const publish = usePublishProject(profileId);
  const period = useProjectPeriod();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<PortfolioProjectDto | null>(null);
  const [viewing, setViewing] = useState<PortfolioProjectDto | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadTarget, setUploadTarget] = useState<string | null>(null);

  const run = (fn: () => Promise<unknown>) => {
    setErr(null);
    return fn().catch((e) => setErr(photoErrorText(e, t)));
  };

  function pickPhoto(projectId: string): void {
    setUploadTarget(projectId);
    fileInputRef.current?.click();
  }

  let body: JSX.Element;
  if (!profileId || isPending) {
    body = <Skeleton height={160} />;
  } else if (error) {
    body = (
      <ErrorState
        title={t('common.unexpectedErrorTitle')}
        text={apiErrorText(error)}
        code={error instanceof ApiError ? error.code : undefined}
        retryLabel={t('common.retry')}
        onRetry={() => void refetch()}
      />
    );
  } else if (!data || data.length === 0) {
    body = <EmptyState icon="reputation" title={t('profile.portfolioEmptyTitle')} text={t('profile.portfolioEmptyText')} />;
  } else {
    body = (
      <div className={styles.grid} data-testid="portfolio-list">
        {data.map((project) => (
          <Card key={project.id} className={styles.item}>
            <button type="button" className={styles.cover} onClick={() => setViewing(project)} aria-label={t('profile.portfolioOpenWork')} data-testid={`portfolio-open-${project.id}`}>
              {project.photo_url ? (
                <img src={`${project.photo_url}&size=320`} alt={project.title} className={styles.photo} />
              ) : (
                <div className={styles.photoPlaceholder} aria-hidden="true" />
              )}
            </button>
            <div className={styles.itemBody}>
              <strong>{project.title}</strong>
              <span className={styles.meta}>
                {t(sphereKey(project.sphere))}
                {period(project) ? <span>· {period(project)}</span> : null}
                {project.location_label ? <span>· {project.location_label}</span> : null}
                {project.is_verified ? <Badge tone="green">{t('profile.portfolioVerified')}</Badge> : null}
                <Badge tone={project.is_published ? 'teal' : 'neutral'}>
                  {t(project.is_published ? 'profile.portfolioPublished' : 'profile.portfolioDraft')}
                </Badge>
              </span>
              {project.description ? <p className={styles.description}>{project.description}</p> : null}

              <div className={styles.gallery} data-testid={`portfolio-photos-${project.id}`}>
                <span className={styles.meta}>
                  {t('profile.portfolioPhotosTitle', { count: project.photos.length, max: MAX_PHOTOS })}
                  <FieldHelp label={t('hints.helpButton')}>{t('hints.portfolio.photos')}</FieldHelp>
                </span>
                <div className={styles.thumbs}>
                  {project.photos.map((photo) => (
                    <div key={photo.id} className={styles.thumb}>
                      <img src={photoSrc(photo.url, 320)} alt="" />
                      {photo.is_primary ? (
                        <Badge tone="teal" className={styles.thumbBadge}>{t('profile.portfolioPhotoPrimary')}</Badge>
                      ) : (
                        <button
                          type="button"
                          className={styles.thumbAction}
                          onClick={() => void run(() => setPrimary.mutateAsync({ projectId: project.id, photoId: photo.id }))}
                          data-testid={`portfolio-photo-primary-${photo.id}`}
                        >
                          {t('profile.portfolioPhotoMakePrimary')}
                        </button>
                      )}
                      <button
                        type="button"
                        className={styles.thumbRemove}
                        aria-label={t('profile.portfolioPhotoRemove')}
                        onClick={() => void run(() => removePhoto.mutateAsync({ projectId: project.id, photoId: photo.id }))}
                        data-testid={`portfolio-photo-remove-${photo.id}`}
                      >
                        <Icon name="close" size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className={styles.actions}>
                {project.photos.length < MAX_PHOTOS ? (
                  <Button size="sm" variant="secondary" loading={addPhoto.isPending && uploadTarget === project.id} onClick={() => pickPhoto(project.id)} data-testid={`portfolio-photo-add-${project.id}`}>
                    {t('profile.portfolioPhotoAdd')}
                  </Button>
                ) : (
                  <span className={styles.meta}>{t('profile.portfolioPhotosLimit')}</span>
                )}
                <Button size="sm" variant="ghost" leftIcon={<Icon name="edit" size={16} />} onClick={() => setEditing(project)} data-testid={`portfolio-edit-${project.id}`}>
                  {t('profile.portfolioEdit')}
                </Button>
                {!project.is_published ? (
                  <Button size="sm" variant="ghost" loading={publish.isPending} onClick={() => void run(() => publish.mutateAsync(project.id))}>
                    {t('profile.portfolioPublish')}
                  </Button>
                ) : null}
              </div>
            </div>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <h2 className={styles.title}>{t('profile.portfolioTitle')}</h2>
        <Button variant="primary" onClick={() => setCreateOpen(true)} data-testid="portfolio-add">
          {t('profile.portfolioAdd')}
        </Button>
      </div>
      {err ? <Callout tone="warn">{err}</Callout> : null}
      {body}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className={styles.fileInput}
        data-testid="portfolio-photo-input"
        aria-label={t('profile.portfolioPhotoAdd')}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file && uploadTarget) void run(() => addPhoto.mutateAsync({ projectId: uploadTarget, file }));
          e.target.value = '';
        }}
      />

      <ProjectFormModal
        open={createOpen}
        title={t('profile.portfolioAdd')}
        submitLabel={t('profile.portfolioAdd')}
        pending={create.isPending}
        onClose={() => setCreateOpen(false)}
        onSubmit={(input) =>
          create
            .mutateAsync(input)
            .then(() => {
              setCreateOpen(false);
              return null;
            })
            .catch(toApiError)
        }
      />
      <ProjectFormModal
        open={editing !== null}
        initial={editing ?? undefined}
        initialSphere={editing?.sphere}
        title={t('profile.portfolioEditTitle')}
        submitLabel={t('profile.save')}
        pending={update.isPending}
        onClose={() => setEditing(null)}
        onSubmit={(input) =>
          update
            .mutateAsync({ projectId: editing?.id ?? '', patch: input })
            .then(() => {
              setEditing(null);
              return null;
            })
            .catch(toApiError)
        }
      />
      <ProjectViewModal project={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
