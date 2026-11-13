import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSpheres, useWorkTypes } from '../../features/contractNew/api';
import { useContractNewStore } from '../../features/contractNew/draftStore';
import { SpherePicker } from '@porukam/ui';
import { useDebounced } from '../../shared/useDebounced';
import { WizardFooter } from './WizardFooter';
import wizardStyles from './ContractNewPage.module.css';
import styles from './SphereStep.module.css';

/**
 * Подшаг «Сфера» (только услуга) — локальный выбор, БЕЗ запроса: `sphere_code` —
 * обязательное поле form_data-схемы услуги (`backend/apps/contracts/forms.py`,
 * SERVICE_SCHEMA), а PATCH form_data — полная замена с полной валидацией, частичную
 * форму сервер не примет (422 required). Код уйдёт вместе с существом на шаге «Суть».
 * `workType` — только контекст рекомендаций чек-листа (ADR-091), в form_data его нет.
 *
 * ADR-100: в выдаче поиска ПЕРВЫМИ идут совпавшие типы работ (`work_types`) —
 * выбор одного задаёт сферу и вид работ сразу; сферы — ниже, как прежде.
 *
 * ADR-097: поиск нечёткий (сервер/мок), ввод дебаунсится; выбор сферы очищает
 * строку поиска и закрывает список, повторный поиск с уже выбранной сферой
 * подсвечивает её и заменяет по клику. `workType` хранится КОДОМ (бэкенд ждёт
 * код категории в `GET /checklist-recommendations?workType=`), имя — только вид.
 */
export function SphereStep(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const sphereName = useContractNewStore((s) => s.sphereName);
  const sphereCode = useContractNewStore((s) => s.sphereCode);
  const workType = useContractNewStore((s) => s.workType);
  const setSphere = useContractNewStore((s) => s.setSphere);
  const setWorkType = useContractNewStore((s) => s.setWorkType);

  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const debouncedQuery = useDebounced(query, 250);
  const { data } = useSpheres(debouncedQuery);
  const { data: workTypes } = useWorkTypes(sphereCode);

  return (
    <>
      <h2 className={wizardStyles.stepTitle}>{t('contractNew.sphereTitle')}</h2>
      <p className={wizardStyles.stepSub}>{t('contractNew.sphereSub')}</p>

      <SpherePicker
        query={query}
        onQueryChange={setQuery}
        results={data?.results}
        popular={data?.popular ?? []}
        selectedCode={sphereCode || undefined}
        showAll={showAll}
        onToggleShowAll={() => setShowAll((v) => !v)}
        searchLabel={t('contractNew.sphereSearchLabel')}
        searchPlaceholder={t('contractNew.sphereSearchPlaceholder')}
        popularLabel={t('contractNew.spherePopular')}
        browseAllLabel={t('contractNew.sphereBrowseAll')}
        emptyHint={t('contractNew.sphereEmptyHint')}
        workTypes={data?.work_types ?? []}
        workTypesLabel={t('contractNew.sphereWorkTypesLabel')}
        spheresLabel={t('contractNew.sphereSpheresLabel')}
        selectedWorkTypeCode={workType || undefined}
        onPickWorkType={(w) => {
          // ADR-100: тип работ в выдаче задаёт и сферу, и вид работ одним
          // нажатием («мебель» → «Мебель: сборка и ремонт» в «Ремонт и строительство»).
          setSphere(w.sphere_name, w.sphere_code);
          setWorkType(w.code);
          setQuery('');
          setShowAll(false);
        }}
        onPick={(s) => {
          setSphere(s.name, s.code);
          setWorkType('');
          // Выбор закрывает выдачу: строка поиска очищается, «все сферы»
          // сворачиваются — иначе список оставался открытым поверх выбора,
          // и связь «поиск ↔ выбранная сфера» терялась (замечание отсмотра).
          setQuery('');
          setShowAll(false);
        }}
      />

      {sphereName ? (
        <div className={styles.chosen} data-testid="sphere-chosen">
          {sphereName}
        </div>
      ) : null}

      {sphereName && workTypes && workTypes.length > 0 ? (
        <div className={styles.workTypes}>
          {workTypes.map((w) => (
            <button
              key={w.code}
              type="button"
              className={`${styles.chip} ${workType === w.code ? styles.chipActive : ''}`}
              aria-pressed={workType === w.code}
              onClick={() => setWorkType(w.code)}
              data-testid={`work-type-${w.code}`}
            >
              {w.name}
            </button>
          ))}
        </div>
      ) : null}

      <WizardFooter onBack={() => navigate('../type')} onNext={() => navigate('../parties')} nextDisabled={!sphereName} />
    </>
  );
}
