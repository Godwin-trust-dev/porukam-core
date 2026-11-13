import { useEffect } from 'react';
import { Navigate, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { matchBundledLocale } from '@porukam/i18n';
import type { LegalDocSlug } from '@porukam/core';
import { ErrorState, MarkdownDocument, Skeleton } from '@porukam/ui';
import { applyLocale } from '../features/locale/applyLocale';
import { useLegalDocument } from '../features/legal/api';
import styles from './LegalDocumentPage.module.css';

const SLUGS: LegalDocSlug[] = ['terms', 'privacy'];

/**
 * Юр-документ ОТДЕЛЬНОЙ ПУБЛИЧНОЙ СТРАНИЦЕЙ: `/legal/terms`, `/legal/privacy`.
 *
 * Зачем, если те же документы уже открываются шторкой на /welcome и шаге
 * согласий: магазины приложений (Google Play — обязательное поле «Privacy
 * policy» в Play Console, Apple — то же в App Store Connect) требуют ССЫЛКУ
 * на страницу, которая открывается у постороннего человека в браузере без
 * входа в приложение. Шторка внутри SPA такой ссылкой быть не может — на неё
 * нельзя сослаться и её не увидит проверяющий. Тот же текст, тот же источник
 * (`GET /v1/legal/<doc>`), никакой второй копии документа в репозитории.
 *
 * `?lang=` — язык документа в самой ссылке: проверяющему из Google нужен
 * английский независимо от языка, выбранного в браузере, а сослаться на
 * конкретный язык иначе нечем. Код сверяется с реестром языков сборки
 * (`matchBundledLocale`), мусор в параметре просто игнорируется, и остаётся
 * язык интерфейса. Переключаем через `applyLocale` — сначала чанк, потом
 * `changeLanguage`, иначе экран мигает английским (ADR-089).
 */
export function LegalDocumentPage(): JSX.Element {
  const { doc } = useParams<{ doc: string }>();
  const [searchParams] = useSearchParams();
  const { t, i18n } = useTranslation();

  const requestedLang = matchBundledLocale(searchParams.get('lang'));
  useEffect(() => {
    if (requestedLang) void applyLocale(i18n, requestedLang);
  }, [requestedLang, i18n]);

  const slug = SLUGS.includes(doc as LegalDocSlug) ? (doc as LegalDocSlug) : null;
  const { data, isPending, isError, refetch } = useLegalDocument(slug, i18n.language);

  const title = slug === 'privacy' ? t('auth.privacyLinkLabel') : t('auth.tosLinkLabel');
  // Вкладка и результат в поиске должны называть документ, а не «Porukam».
  useEffect(() => {
    if (slug) document.title = `${title} — Porukam`;
  }, [slug, title]);

  // Документ пришёл не на том языке, который просили, — сработал EN-фолбэк.
  // Признак берём из ОТВЕТА, как в шторке: языковой пакет интерфейса и пакет
  // юр-документов наполняются независимо и расходятся именно между собой.
  const fellBackToEnglish = data ? data.locale !== data.requested_locale : false;

  if (!slug) {
    return (
      <main className={styles.page}>
        <ErrorState title={t('legal.loadError')} code="not_found" />
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <article className={styles.sheet}>
        <header className={styles.head}>
          <p className={styles.brand}>Porukam</p>
          <h1 className={styles.title}>{title}</h1>
        </header>

        {isPending ? (
          <>
            <Skeleton width="100%" height={24} />
            <Skeleton width="100%" height={320} />
          </>
        ) : null}

        {isError ? (
          <ErrorState title={t('legal.loadError')} retryLabel={t('common.retry')} onRetry={() => void refetch()} />
        ) : null}

        {data ? (
          <>
            {data.quality === 'machine' ? (
              <p className={styles.note} title={t('legal.machineNoteTooltip')}>
                {t('legal.machineNoteLabel')}
              </p>
            ) : null}
            {fellBackToEnglish ? <p className={styles.note}>{t('legal.fallbackNotice')}</p> : null}
            {data.notice ? <p className={styles.notice}>{data.notice}</p> : null}
            <MarkdownDocument source={data.body} />
          </>
        ) : null}
      </article>
    </main>
  );
}

/** `/legal/tos` — прежний ошибочный адрес из подвала: ведёт на условия, `?lang=` сохраняется. */
export function LegalTosRedirect(): JSX.Element {
  const { search } = useLocation();
  return <Navigate to={`/legal/terms${search}`} replace />;
}
