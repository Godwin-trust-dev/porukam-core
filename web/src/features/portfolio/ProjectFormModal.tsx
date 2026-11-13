import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@porukam/core';
import { Button, Modal, SelectField, TextArea, TextField } from '@porukam/ui';
import { apiErrorText } from '../../shared/apiErrorText';
import { sphereKey } from './ProjectView';
import styles from './ProjectFormModal.module.css';

const SPHERES = ['renovation', 'delivery', 'education', 'it', 'household', 'design', 'other'] as const;

/** Значения формы работы. `sphere` — просто код: у человека это плоский enum
 * (ADR-120), у объединения — код каталога (ADR-128); что именно рисовать,
 * решает `renderSphere`. */
export interface ProjectFormValue {
  title: string;
  sphere: string;
  description: string;
  started_at: string | null;
  completed_at: string;
  location_label: string;
}

/** Общая часть DTO работы человека (`PortfolioProjectDto`) и работы
 * объединения (`GroupPortfolioProjectDto`) — всё, кроме сферы: её имя поля
 * у них разное, поэтому она приходит отдельным пропом. */
export interface ProjectFormSource {
  title: string;
  description: string;
  started_at: string | null;
  completed_at: string | null;
  location_label: string;
}

function formFrom(p: ProjectFormSource | undefined, sphere: string): ProjectFormValue {
  return {
    title: p?.title ?? '',
    sphere,
    description: p?.description ?? '',
    started_at: p?.started_at ?? null,
    completed_at: p?.completed_at ?? '',
    location_label: p?.location_label ?? '',
  };
}

/**
 * Форма работы — создание и редактирование (ADR-120, ADR-128): дата завершения
 * обязательна, начало/город — нет, описание без лимита. Одна на обе витрины —
 * личную (`/me/portfolio`) и объединения (карточка объединения).
 *
 * Отдельный компонент — инлайн-модалка в ре-рендерящейся странице теряет фокус
 * ввода. По той же причине `initial` обязан быть СТАБИЛЬНОЙ ссылкой (объект из
 * состояния вызывающего, не создаваемый на каждый рендер): он в зависимостях
 * эффекта, который сбрасывает поля.
 */
export function ProjectFormModal({
  open,
  initial,
  initialSphere,
  sphereFallback = 'renovation',
  renderSphere,
  title,
  submitLabel,
  pending,
  onClose,
  onSubmit,
}: {
  open: boolean;
  initial?: ProjectFormSource;
  /** Код сферы редактируемой работы (`sphere` у человека, `sphere_code` у
   * объединения); пусто при создании — берётся `sphereFallback`. */
  initialSphere?: string;
  /** Что подставить, когда сферы нет: у объединения — его собственная сфера. */
  sphereFallback?: string;
  /** Своё поле сферы. По умолчанию — плоский список ADR-120. */
  renderSphere?: (value: string, onChange: (code: string) => void) => ReactNode;
  title: string;
  submitLabel: string;
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: ProjectFormValue) => Promise<ApiError | null>;
}): JSX.Element {
  const { t } = useTranslation();
  const startSphere = initialSphere || sphereFallback;
  const [value, setValue] = useState<ProjectFormValue>(() => formFrom(initial, startSphere));
  const [dateError, setDateError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValue(formFrom(initial, startSphere));
      setDateError(null);
      setServerError(null);
    }
  }, [open, initial, startSphere]);

  const set = (patch: Partial<ProjectFormValue>): void => setValue((v) => ({ ...v, ...patch }));

  async function submit(): Promise<void> {
    setServerError(null);
    if (!value.completed_at) {
      setDateError(t('profile.portfolioCompletedAtRequired'));
      return;
    }
    if (value.started_at && value.started_at > value.completed_at) {
      setDateError(t('profile.portfolioDatesInvalid'));
      return;
    }
    setDateError(null);
    const err = await onSubmit({
      ...value,
      title: value.title.trim(),
      description: value.description.trim(),
      location_label: value.location_label.trim(),
      started_at: value.started_at || null,
    });
    if (!err) return;
    if (err.code === 'portfolio_dates_invalid') setDateError(t('profile.portfolioDatesInvalid'));
    else setServerError(apiErrorText(err) ?? err.message);
  }

  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      closeLabel={t('common.close')}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!value.title.trim()} loading={pending} data-testid="portfolio-form-submit" onClick={() => void submit()}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <TextField
        label={t('profile.portfolioTitleLabel')}
        help={t('hints.portfolio.title')}
        helpLabel={t('hints.helpButton')}
        required
        value={value.title}
        onChange={(e) => set({ title: e.target.value })}
        data-testid="portfolio-title"
      />
      {renderSphere ? (
        renderSphere(value.sphere, (code) => set({ sphere: code }))
      ) : (
        <SelectField
          label={t('profile.portfolioSphereLabel')}
          help={t('hints.portfolio.sphere')}
          helpLabel={t('hints.helpButton')}
          value={value.sphere}
          onChange={(e) => set({ sphere: e.target.value })}
          data-testid="portfolio-sphere"
        >
          {SPHERES.map((code) => (
            <option key={code} value={code}>
              {t(sphereKey(code))}
            </option>
          ))}
        </SelectField>
      )}
      <div className={styles.dates}>
        <TextField
          label={t('profile.portfolioStartedAtLabel')}
          help={t('hints.portfolio.startedAt')}
          helpLabel={t('hints.helpButton')}
          type="date"
          value={value.started_at ?? ''}
          onChange={(e) => set({ started_at: e.target.value || null })}
          data-testid="portfolio-started-at"
        />
        <TextField
          label={t('profile.portfolioCompletedAtLabel')}
          help={t('hints.portfolio.completedAt')}
          helpLabel={t('hints.helpButton')}
          type="date"
          required
          value={value.completed_at}
          error={dateError ?? undefined}
          onChange={(e) => set({ completed_at: e.target.value })}
          data-testid="portfolio-completed-at"
        />
      </div>
      <TextField
        label={t('profile.portfolioCityLabel')}
        help={t('hints.portfolio.city')}
        helpLabel={t('hints.helpButton')}
        value={value.location_label}
        onChange={(e) => set({ location_label: e.target.value })}
        data-testid="portfolio-city"
      />
      <TextArea
        label={t('profile.portfolioDescriptionLabel')}
        hint={t('profile.portfolioDescriptionHint')}
        help={t('hints.portfolio.description')}
        helpLabel={t('hints.helpButton')}
        /* 390×844: с rows=8 кнопки модалки уезжали за экран (мобильный проход 25.08);
           описание без лимита, поле растёт прокруткой внутри себя. */
        rows={4}
        value={value.description}
        onChange={(e) => set({ description: e.target.value })}
        data-testid="portfolio-description"
      />
      {serverError ? <p role="alert" style={{ color: 'var(--pr-danger, #b3261e)' }}>{serverError}</p> : null}
    </Modal>
  );
}

/** Человекочитаемый текст ошибок фото — общий для обеих витрин: бэк отдаёт
 * одни и те же коды (ADR-128 §4). */
export function photoErrorText(e: unknown, t: (k: string) => string): string {
  if (e instanceof ApiError) {
    if (e.code === 'portfolio_photos_limit') return t('profile.portfolioPhotosLimit');
    if (e.code === 'portfolio_photo_too_large') return t('profile.portfolioPhotoTooLarge');
    if (e.code === 'invalid_portfolio_image') return t('profile.portfolioPhotoInvalid');
    return apiErrorText(e) ?? e.message;
  }
  return String(e);
}

/** Ошибку мутации приводим к ApiError — форма показывает её на нужном поле. */
export function toApiError(e: unknown): ApiError {
  return e instanceof ApiError ? e : new ApiError(0, { status: 0, title: String(e) });
}
