import { useTranslation } from 'react-i18next';
import type { LegalDocSlug } from '@porukam/core';
import { LegalDocumentSheet } from '@porukam/ui';
import { useLegalDocument } from './api';

export interface LegalDocumentDialogProps {
  /** `null` — шторка закрыта, запрос не идёт. */
  doc: LegalDocSlug | null;
  onClose: () => void;
}

/**
 * Юр-документ платформы на языке интерфейса (docs/tasks/
 * Задача_feat_l10n-launch-surfaces.md §B) — одна точка для всех поверхностей,
 * где на документы ссылаются (/welcome и шаг согласий): и заголовок, и
 * состояния загрузки/ошибки, и пометки берутся здесь, а страницы только
 * говорят, КАКОЙ документ открыть.
 *
 * Заголовок шторки — та же строка, что на ссылке (`auth.tosLinkLabel` /
 * `auth.privacyLinkLabel`): человек должен увидеть в шапке ровно то, на что
 * нажал, а не второе название того же документа.
 */
export function LegalDocumentDialog({ doc, onClose }: LegalDocumentDialogProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const { data, isPending, isError, refetch } = useLegalDocument(doc, i18n.language);

  const title = doc === 'terms' ? t('auth.tosLinkLabel') : t('auth.privacyLinkLabel');
  // Документ пришёл не на том языке, который просили, — сработал EN-фолбэк.
  // Признак считаем по ОТВЕТУ, а не по наличию перевода на фронте: языковой
  // пакет UI и юр-документ наполняются независимо (packages/i18n против
  // l10n/packs), и разойтись могут именно они.
  const fellBackToEnglish = data ? data.locale !== data.requested_locale : false;

  return (
    <LegalDocumentSheet
      open={doc !== null}
      title={title}
      onClose={onClose}
      closeLabel={t('common.close')}
      body={data?.body}
      notice={data?.notice ?? null}
      machine={data?.quality === 'machine'}
      machineLabel={t('legal.machineNoteLabel')}
      machineTooltip={t('legal.machineNoteTooltip')}
      fallbackNotice={fellBackToEnglish ? t('legal.fallbackNotice') : null}
      loading={doc !== null && isPending}
      errorText={isError ? t('legal.loadError') : undefined}
      retryLabel={t('common.retry')}
      onRetry={() => void refetch()}
    />
  );
}
