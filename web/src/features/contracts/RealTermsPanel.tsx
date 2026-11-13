import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RealContract } from '@porukam/core';
import { Badge, Button, Callout, Card, Disclosure } from '@porukam/ui';
import { HIDDEN_KEYS, useContractFieldLabeller } from './contractFields';
import { useSphereName } from '../groups/useSphereName';
import { useFormatters } from '../../shared/formatters';
import { PAY_LABEL_KEY, contractTypeLabelKey } from './RealContractRow';
import { paymentOrderApplicableForType, paymentOrderLabelKey } from '../contractNew/paymentOrders';
import { useContractVersion } from './realSigningApi';
import { RetentionNotice } from './RetentionNotice';
import styles from './RealTermsPanel.module.css';

/**
 * Вкладка «Условия» реального договора (отсмотр 2026-08-24: «вторая сторона
 * должна видеть полностью все условия — сейчас такой возможности нет, по
 * крайней мере на мобильном»). До этого полные условия жили только в мастере
 * инициатора; экран подписания показывал хеш и подписи, не текст. Здесь —
 * всё, что войдёт в снимок при заморозке (`_build_snapshot` бэка): тип,
 * способ расчёта, юрисдикция, сумма, `form_data` целиком с человеческими
 * подписями; после заморозки — поля из замороженного снимка, а не живые.
 *
 * Раскладка — доска B «Условия (свёрнутые блоки)» (DEV-20_2 §4/§11): сверху
 * юр-блоки строкой-заголовком («Платформа — оператор, а не сторона»,
 * «Подлинность документов — бессрочно»), тёмная кнопка «Смотреть все условия»
 * раскрывает полный список полей на месте, «Замечания N» — свёрнуты.
 */
export function RealTermsPanel({ contract }: { contract: RealContract }): JSX.Element {
  const { t } = useTranslation();
  const { formatDate, formatMoney } = useFormatters();
  const { labelOf, valueOf } = useContractFieldLabeller(contract.contract_type_code);
  const [showAll, setShowAll] = useState(false);
  const versionQ = useContractVersion(contract.id, contract.frozen_version_id ?? undefined);
  const version = versionQ.data;
  const frozenDocument = version
    ? ((version.renders[version.official_language] ?? Object.values(version.renders)[0])?.document as
        | { form_data?: Record<string, unknown>; title?: string; additional_terms?: string[] }
        | undefined)
    : undefined;
  const formData: Record<string, unknown> = frozenDocument?.form_data ?? contract.form_data ?? {};
  const sphereCode = typeof formData.sphere_code === 'string' ? formData.sphere_code : '';
  const sphereName = useSphereName(sphereCode);
  // ADR-123: дополнительные условия — принятые правки «Другое». После заморозки
  // читаем их из снимка версии: подписывают именно его, а не живой договор.
  const frozenSnapshot = version?.snapshot as { additional_terms?: unknown } | undefined;
  const snapshotTerms = Array.isArray(frozenSnapshot?.additional_terms) ? (frozenSnapshot.additional_terms as unknown[]) : undefined;
  const additionalTerms: string[] = version
    ? (frozenDocument?.additional_terms ?? snapshotTerms ?? []).map(String)
    : (contract.additional_terms ?? []);

  const rows = Object.entries(formData)
    .filter(([key]) => !HIDDEN_KEYS.has(key))
    .map(([key, raw]) => ({ key, label: labelOf(key), value: valueOf(key, raw) }))
    .filter((r): r is { key: string; label: string; value: string } => r.value !== null);

  const typeLabelKey = contractTypeLabelKey(contract.contract_type_code);
  const generalRows: { label: string; value: string }[] = [
    ...(typeLabelKey ? [{ label: t('contract.termsTypeLabel'), value: t(typeLabelKey) }] : []),
    ...(sphereCode ? [{ label: t('contractNew.sphereSpheresLabel'), value: sphereName }] : []),
    {
      label: t('contract.card.moneyMethodLabel'),
      value: contract.payment_method ? t(PAY_LABEL_KEY[contract.payment_method]) : t('contracts.payNone'),
    },
    // ADR-151: порядок оплаты — условие договора (в snapshot заморозки);
    // у займа неприменим — строки нет.
    ...(paymentOrderApplicableForType(contract.contract_type_code)
      ? [
          {
            label: t('contractNew.paymentOrderLabel'),
            value: paymentOrderLabelKey(contract.payment_order)
              ? t(paymentOrderLabelKey(contract.payment_order)!)
              : t('contracts.payOrderNone'),
          },
        ]
      : []),
    { label: t('contract.jurisdictionLabel'), value: contract.jurisdiction },
    { label: t('signing.sum'), value: contract.total ? formatMoney(contract.total) : t('contracts.amountUnset') },
  ];

  return (
    <div className={styles.wrap} data-testid="real-terms-panel">
      <Callout tone="operator" collapsible title={t('contract.operatorDisclaimer')}>
        {t('contract.operatorDisclaimerText')}
      </Callout>

      {/* ADR-137 требование 9: сроки хранения — тем же тоном, что обещание о
          подлинности, свёрнуто («Подробнее»). */}
      <RetentionNotice variant="compact" />

      <Button
        variant="secondary"
        block
        onClick={() => setShowAll((v) => !v)}
        aria-expanded={showAll}
        data-testid="see-all-terms"
      >
        {showAll ? t('contract.termsHideAll') : t('contract.termsSeeAll')}
      </Button>

      {/* DEV-20_2 §4: «Замечания» — свёрнуты, счётчик в заголовке, раскрытие
          на всю ширину блока. */}
      {contract.warnings.length > 0 ? (
        <Disclosure variant="row" tone="attention" label={t('contract.warningsTitle')} count={contract.warnings.length} data-testid="contract-warnings">
          <ul className={styles.warningsList}>
            {contract.warnings.map((w, i) => (
              <li key={i}>{w.message}</li>
            ))}
          </ul>
        </Disclosure>
      ) : null}

      {showAll ? (
        <div className={styles.wrap} data-testid="real-terms-all">
          {version ? (
            <Callout tone="neutral">
              <Badge tone="teal">{t('signing.frozenBadge')}</Badge>{' '}
              {t('contract.termsFrozenNote', { date: formatDate(version.frozen_at, { legal: true }) })}
            </Callout>
          ) : contract.negotiation_status === 'under_review' ? (
            <Callout tone="neutral">{t('contract.termsLiveNote')}</Callout>
          ) : null}

          <Card>
            <h3 className={styles.sectionTitle}>{t('contract.termsSectionGeneral')}</h3>
            <dl className={styles.list}>
              {generalRows.map((r) => (
                <div key={r.label} className={styles.row}>
                  <dt className={styles.label}>{r.label}</dt>
                  <dd className={styles.value}>{r.value}</dd>
                </div>
              ))}
            </dl>
          </Card>

          <Card>
            <h3 className={styles.sectionTitle}>{t('contract.termsTitle')}</h3>
            {rows.length === 0 ? (
              <p className={styles.empty}>{t('contract.termsEmpty')}</p>
            ) : (
              <dl className={styles.list} data-testid="real-terms-fields">
                {rows.map((r) => (
                  <div key={r.key} className={styles.row} data-testid={`real-terms-${r.key}`}>
                    <dt className={styles.label}>{r.label}</dt>
                    <dd className={styles.value}>{r.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Card>

          {additionalTerms.length > 0 ? (
            <Card>
              <h3 className={styles.sectionTitle}>{t('contract.termsAdditionalTitle')}</h3>
              <ol className={styles.additional} data-testid="real-terms-additional">
                {additionalTerms.map((term, i) => (
                  <li key={`${i}-${term}`}>{term}</li>
                ))}
              </ol>
            </Card>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
