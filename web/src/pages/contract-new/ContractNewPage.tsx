import { useEffect } from 'react';
import { Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Icon, ScreenHeader, Skeleton, Stepper } from '@porukam/ui';
import { useContractNewStore } from '../../features/contractNew/draftStore';
import { seedStoreFromDraft } from '../../features/contractNew/draftResume';
import { stepsFor } from '../../features/contractNew/steps';
import { useConstructorStepTracking } from '../../features/analytics/useConstructorStepTracking';
import { useRealContract } from '../../features/contracts/realApi';
import { useActorStore } from '../../features/actor/actorStore';
import { useShellHeader } from '../../features/shell/shellHeader';
import styles from './ContractNewPage.module.css';

/**
 * ADR-088 Фаза 2 — обёртка визарда: шаги как под-маршруты (`/contracts/new/<шаг>`),
 * автосейв на каждом шаге (в дочерних страницах). Стрелка прогресса — по адаптивному
 * списку шагов. При уходе из мастера состояние сбрасывается — черновик (если создан)
 * живёт на сервере и открывается со списка сделок как обычный договор.
 *
 * Доска B («Создание договора», `marketing/reference/front-upgrade`): на телефоне
 * шапка мастера — «Новый договор ×» вместо меню разделов (ADR-152, `useShellHeader`),
 * под ней компакт-степпер одной строкой, а сам шаг лежит прямо на креме — белой
 * карточки на узком экране нет. На десктопе — ряд шагов в строку и белая карточка
 * по центру шириной `--pr-wizard-max` (760px).
 */
export function ContractNewPage(): JSX.Element {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const clientOption = useContractNewStore((s) => s.clientOption);
  const saving = useContractNewStore((s) => s.saving);
  const errorStepPath = useContractNewStore((s) => s.errorStepPath);
  const setCounterpartyPrefill = useContractNewStore((s) => s.setCounterpartyPrefill);
  const reset = useContractNewStore((s) => s.reset);

  // `?counterparty=@handle` (карточка репутации, ADR-093) — предзаполнение шага «Стороны».
  const counterpartyParam = searchParams.get('counterparty') ?? '';
  useEffect(() => {
    if (counterpartyParam) setCounterpartyPrefill(counterpartyParam);
  }, [counterpartyParam, setCounterpartyPrefill]);

  // Сброс — только при реальном уходе из мастера: к моменту cleanup адрес уже
  // новый. При F5 cleanup не выполняется вовсе, при StrictMode-перемонтировании
  // (dev) путь остаётся внутри мастера — персист-контекст (draftStore) выживает.
  useEffect(
    () => () => {
      if (!window.location.pathname.startsWith('/contracts/new')) reset();
    },
    [reset],
  );

  // `?draft=<id>` — «Редактировать» у черновика (ADR-104): контекст мастера
  // восстанавливается из договора; пока он не загружен — скелетон вместо шага,
  // иначе шаг «Суть» на миг видит пустой стор и рисует «форма не подключена».
  const draftParam = searchParams.get('draft');
  const draftId = useContractNewStore((s) => s.draftId);
  const myProfileId = useActorStore((s) => s.activeProfileId);
  const needsSeed = !!draftParam && draftId !== draftParam;
  const resumeQ = useRealContract(needsSeed ? draftParam : undefined);
  useEffect(() => {
    if (needsSeed && resumeQ.data) seedStoreFromDraft(resumeQ.data, myProfileId);
  }, [needsSeed, resumeQ.data, myProfileId]);

  const steps = stepsFor(clientOption);
  const currentPath = location.pathname.split('/').pop();
  const currentIndex = Math.max(
    0,
    steps.findIndex((s) => s.path === currentPath),
  );

  // ADR-145: единственный поведенческий слой продукта — шаги конструктора.
  // Брошенный черновик иначе неизмерим: доменного события «бросил на шаге 3»
  // не существует и не должно существовать. Трекинг живёт здесь, в обёртке,
  // а не в страницах шагов — так у каждого входа есть парный уход, и новый
  // шаг не требует «не забыть».
  const trackedStep = steps.some((s) => s.path === currentPath) ? currentPath : undefined;
  useConstructorStepTracking(trackedStep, draftId);

  // Доска B: «×» закрывает мастер. Черновик (если создан) уже на сервере —
  // ADR-104, откроется со списка как обычный договор; стор сбрасывается
  // эффектом ухода выше.
  const closeButton = (
    <button
      type="button"
      className={styles.close}
      aria-label={t('common.close')}
      onClick={() => navigate('/contracts')}
    >
      <Icon name="close" size={20} />
    </button>
  );
  // Шапка экрана на телефоне (ADR-152): заголовок и «×» уезжают порталом в
  // шапку оболочки, своя прячется CSS — название не стоит дважды.
  const shell = useShellHeader({ title: t('contract.createTitle'), actions: closeButton });

  return (
    <div className={styles.wrap} data-testid="wizard-pane">
      {shell.portal}
      <ScreenHeader
        title={t('contract.createTitle')}
        inShell={shell.inShell}
        actions={closeButton}
        className={styles.head}
      />
      <div className={styles.stepRow}>
        <Stepper
          steps={steps.map((s) => t(`contractNew.steps.${s.key}`))}
          current={currentIndex}
          ariaLabel={t('common.stepAriaLabel', { current: currentIndex + 1, total: steps.length })}
          // Пройденные шаги кликабельны — возврат назад по конвейеру; ошибка
          // «Далее» шага подсвечивает его кружок красным (отсмотр 2026-08-19).
          onStepClick={(i) => {
            const target = steps[i];
            if (target) navigate(`/contracts/new/${target.path}`);
          }}
          errorStep={(() => {
            const i = steps.findIndex((s) => s.path === errorStepPath);
            return i >= 0 ? i : undefined;
          })()}
        />
        {saving ? <span className={styles.autosave}>{t('contractNew.autosaving')}</span> : null}
      </div>
      <div className={styles.body}>
        {needsSeed ? <Skeleton width="100%" height={240} /> : <Outlet />}
      </div>
    </div>
  );
}
