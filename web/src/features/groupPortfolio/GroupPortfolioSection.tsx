import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Group, GroupPortfolioProjectDto } from '@porukam/core';
import { Badge, Button, Callout, Card, Icon, Skeleton, SpherePicker } from '@porukam/ui';
import { useSpheres } from '../contractNew/api';
import { useDebounced } from '../../shared/useDebounced';
import { useSphereNames } from '../groups/useSphereName';
import { ProjectFormModal, type ProjectFormValue, photoErrorText, toApiError } from '../portfolio/ProjectFormModal';
import { ProjectViewModal, photoSrc, useProjectPeriod } from '../portfolio/ProjectView';
import {
  type GroupPortfolioInput,
  useAddGroupProjectPhoto,
  useCreateGroupProject,
  useDeleteGroupProject,
  useGroupPortfolio,
  useRemoveGroupProjectPhoto,
  useSetPrimaryGroupProjectPhoto,
  useUpdateGroupProject,
} from './api';
import formStyles from '../groups/GroupForm.module.css';
import styles from './GroupPortfolioSection.module.css';

/** Столько же, сколько у человека (ADR-128 = ADR-120 §1). */
export const MAX_GROUP_PHOTOS = 5;

/**
 * Витрина работ объединения (ADR-128) — тот же блок, что у человека, но
 * владелец здесь коллективный: смотреть может любой, кому видна карточка
 * объединения, добавлять/править/удалять — только leader/admin.
 *
 * Монтируется ВНУТРИ `GroupCard`, поэтому появляется сразу и на `/groups/{id}`,
 * и на гостевой `/@хендл`; гость обязан увидеть работы и не увидеть кнопок.
 */
export function GroupPortfolioSection({ group }: { group: Group }): JSX.Element | null {
  const { t } = useTranslation();
  const { data, isPending } = useGroupPortfolio(group.id);
  const sphereName = useSphereNames();
  const period = useProjectPeriod();
  const create = useCreateGroupProject(group.id);
  const update = useUpdateGroupProject(group.id);
  const remove = useDeleteGroupProject(group.id);
  const addPhoto = useAddGroupProjectPhoto(group.id);
  const removePhoto = useRemoveGroupProjectPhoto(group.id);
  const setPrimary = useSetPrimaryGroupProjectPhoto(group.id);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<GroupPortfolioProjectDto | null>(null);
  const [viewing, setViewing] = useState<GroupPortfolioProjectDto | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadTarget, setUploadTarget] = useState<string | null>(null);

  const my = group.my_membership;
  const manages = my?.status === 'active' && (my.role === 'leader' || my.role === 'admin');
  const projects = data ?? [];

  // Гостю пустая витрина не нужна вовсе — блок появляется только когда есть
  // что показать либо есть кому наполнять.
  if (!manages && projects.length === 0) return null;

  const run = (fn: () => Promise<unknown>) => {
    setErr(null);
    return fn().catch((e) => setErr(photoErrorText(e, t)));
  };

  function pickPhoto(projectId: string): void {
    setUploadTarget(projectId);
    fileInputRef.current?.click();
  }

  return (
    <Card>
      <div className={styles.head}>
        <h2 className={styles.sectionTitle}>{t('profile.portfolioWorksTitle')}</h2>
        {manages ? (
          <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)} data-testid="group-portfolio-add">
            {t('profile.portfolioAdd')}
          </Button>
        ) : null}
      </div>

      {err ? <Callout tone="warn">{err}</Callout> : null}

      {isPending ? (
        <Skeleton height={120} />
      ) : projects.length === 0 ? (
        <p className={styles.empty}>{t('profile.portfolioEmptyTitle')}</p>
      ) : (
        <div className={styles.grid} data-testid="group-portfolio-list">
          {projects.map((project) => (
            <div key={project.id} className={styles.item}>
              <button
                type="button"
                className={styles.cover}
                onClick={() => setViewing(project)}
                aria-label={`${t('profile.portfolioOpenWork')}: ${project.title}`}
                data-testid={`group-work-${project.id}`}
              >
                {project.photo_url ? (
                  <img src={photoSrc(project.photo_url, 320)} alt="" className={styles.photo} />
                ) : (
                  <div className={styles.photoPlaceholder} aria-hidden="true" />
                )}
                <span className={styles.itemTitle}>{project.title}</span>
              </button>
              <span className={styles.meta}>
                {sphereName(project.sphere_code) ? <span>{sphereName(project.sphere_code)}</span> : null}
                {period(project) ? <span>{period(project)}</span> : null}
                {project.location_label ? <span>{project.location_label}</span> : null}
              </span>

              {manages ? (
                <>
                  <div className={styles.thumbs} data-testid={`group-portfolio-photos-${project.id}`}>
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
                            data-testid={`group-photo-primary-${photo.id}`}
                          >
                            {t('profile.portfolioPhotoMakePrimary')}
                          </button>
                        )}
                        <button
                          type="button"
                          className={styles.thumbRemove}
                          aria-label={t('profile.portfolioPhotoRemove')}
                          onClick={() => void run(() => removePhoto.mutateAsync({ projectId: project.id, photoId: photo.id }))}
                          data-testid={`group-photo-remove-${photo.id}`}
                        >
                          <Icon name="close" size={16} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className={styles.actions}>
                    {project.photos.length < MAX_GROUP_PHOTOS ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={addPhoto.isPending && uploadTarget === project.id}
                        onClick={() => pickPhoto(project.id)}
                        data-testid={`group-photo-add-${project.id}`}
                      >
                        {t('profile.portfolioPhotoAdd')}
                      </Button>
                    ) : (
                      <span className={styles.meta}>{t('profile.portfolioPhotosLimit')}</span>
                    )}
                    <Button size="sm" variant="ghost" leftIcon={<Icon name="edit" size={16} />} onClick={() => setEditing(project)} data-testid={`group-work-edit-${project.id}`}>
                      {t('profile.portfolioEdit')}
                    </Button>
                    {confirmDelete === project.id ? (
                      <>
                        <Button
                          size="sm"
                          variant="destructive"
                          loading={remove.isPending}
                          onClick={() => void run(() => remove.mutateAsync(project.id).then(() => setConfirmDelete(null)))}
                          data-testid={`group-work-delete-confirm-${project.id}`}
                        >
                          {t('profile.portfolioDeleteConfirm')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                          {t('common.cancel')}
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(project.id)} data-testid={`group-work-delete-${project.id}`}>
                        {t('profile.portfolioDelete')}
                      </Button>
                    )}
                  </div>
                </>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {manages ? (
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className={styles.fileInput}
          data-testid="group-portfolio-photo-input"
          aria-label={t('profile.portfolioPhotoAdd')}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file && uploadTarget) void run(() => addPhoto.mutateAsync({ projectId: uploadTarget, file }));
            e.target.value = '';
          }}
        />
      ) : null}

      <ProjectFormModal
        open={createOpen}
        sphereFallback={group.sphere_code}
        renderSphere={renderSphereField}
        title={t('profile.portfolioAdd')}
        submitLabel={t('profile.portfolioAdd')}
        pending={create.isPending}
        onClose={() => setCreateOpen(false)}
        onSubmit={(input) =>
          create
            .mutateAsync(toInput(input))
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
        initialSphere={editing?.sphere_code}
        sphereFallback={group.sphere_code}
        renderSphere={renderSphereField}
        title={t('profile.portfolioEditTitle')}
        submitLabel={t('profile.save')}
        pending={update.isPending}
        onClose={() => setEditing(null)}
        onSubmit={(input) =>
          update
            .mutateAsync({ projectId: editing?.id ?? '', patch: toInput(input) })
            .then(() => {
              setEditing(null);
              return null;
            })
            .catch(toApiError)
        }
      />
      <ProjectViewModal
        project={viewing}
        sphereLabel={viewing ? sphereName(viewing.sphere_code) || undefined : undefined}
        onClose={() => setViewing(null)}
      />
    </Card>
  );
}

/** Значения формы → тело запроса: у объединения сфера зовётся `sphere_code`
 * (код каталога), общая форма держит её просто как `sphere`. */
function toInput({ sphere, ...rest }: ProjectFormValue): GroupPortfolioInput {
  return { ...rest, sphere_code: sphere };
}

function renderSphereField(value: string, onChange: (code: string) => void): JSX.Element {
  return <SphereField value={value} onChange={onChange} />;
}

/** Сфера работы объединения — код КАТАЛОГА (ADR-128 §2), поэтому пикер тот же,
 * что в форме объединения, а не плоский список личного портфолио. Выбранная
 * сфера показывается строкой, пикер разворачивается по «Изменить». */
function SphereField({ value, onChange }: { value: string; onChange: (code: string) => void }): JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(!value);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const { data: spheres } = useSpheres(useDebounced(query, 250));
  const name = useSphereNames()(value);

  return (
    <div className={formStyles.sphere} data-testid="group-work-sphere">
      <span className={formStyles.sphereLabel}>{t('profile.portfolioSphereLabel')}</span>
      {value && !open ? (
        <div className={formStyles.sphereChosen}>
          <span className={formStyles.sphereName} data-testid="group-work-sphere-name">{name}</span>
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
            {t('dashboard.groupSphereChange')}
          </Button>
        </div>
      ) : (
        <SpherePicker
          query={query}
          onQueryChange={setQuery}
          results={spheres?.results}
          popular={spheres?.popular ?? []}
          selectedCode={value || undefined}
          showAll={showAll}
          onToggleShowAll={() => setShowAll((v) => !v)}
          searchLabel={t('contractNew.sphereSearchLabel')}
          searchPlaceholder={t('contractNew.sphereSearchPlaceholder')}
          popularLabel={t('contractNew.spherePopular')}
          browseAllLabel={t('contractNew.sphereBrowseAll')}
          emptyHint={t('contractNew.sphereEmptyHint')}
          onPick={(s) => {
            onChange(s.code);
            setQuery('');
            setShowAll(false);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}
