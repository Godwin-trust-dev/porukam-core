import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError, type ContractKind } from '@porukam/core';
import { Button, Segmented, Skeleton, TypePicker, type TypePickerTile } from '@porukam/ui';
import { useContractTypes } from '../../features/contractNew/api';
import { clientOptionFromTypeCode } from '../../features/contractNew/draftResume';
import { useContractNewStore, type ClientOption } from '../../features/contractNew/draftStore';
import { usePatchRealContract, useRealContract } from '../../features/contracts/realApi';
import { useActorStore } from '../../features/actor/actorStore';
import { WizardFooter } from './WizardFooter';
import wizardStyles from './ContractNewPage.module.css';
import styles from './TypeStep.module.css';

/** Плитка UI (ContractKind) ↔ опция клиентского дерева (ADR-094). */
const TILE_TO_OPTION: Record<string, ClientOption> = {
  service: 'service',
  sale: 'sale',
  rent_items: 'rent',
  loan: 'loan',
};
const OPTION_TO_TILE: Record<ClientOption, ContractKind> = {
  service: 'service',
  sale: 'sale',
  rent: 'rent_items',
  loan: 'loan',
};

/**
 * Шаг «Тип» (ADR-088 Фаза 2, ADR-094) — 4 опции клиентского дерева. Черновик
 * ЗДЕСЬ НЕ создаётся: реальному `POST /contracts` нужен контрагент (шаг
 * «Стороны»). «Услуга» уходит как `client_option` (код резолвит сервер по
 * статусу исполнителя), Продажа/Аренда требуют уточнения кода из
 * `GET /contract-types`, у Займа код единственный — выбирается сам.
 *
 * У уже созданного черновика тип и «кем выступаю» РЕДАКТИРУЕМЫ (ADR-104:
 * всё правится до отправки) — «Далее» шлёт `PATCH /contracts/{id}`
 * (`client_option`/`contract_type_code`, `my_acting_as`; бэк пересчитывает
 * segment, а при смене типа перевалидирует форму — шлём пустую, суть
 * заполняется заново под новый тип). Зафиксирована только РОЛЬ: кто
 * заказчик/исполнитель PATCH не меняет (`patch_draft`).
 */
export function TypeStep(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const draftId = useContractNewStore((s) => s.draftId);
  const setSaving = useContractNewStore((s) => s.setSaving);
  const myProfileId = useActorStore((s) => s.activeProfileId);
  const { data: draft } = useRealContract(draftId ?? undefined);
  const patch = usePatchRealContract(draftId ?? undefined);
  const [serverError, setServerError] = useState<string | null>(null);
  const clientOption = useContractNewStore((s) => s.clientOption);
  const setClientOption = useContractNewStore((s) => s.setClientOption);
  const contractTypeCode = useContractNewStore((s) => s.contractTypeCode);
  const setContractTypeCode = useContractNewStore((s) => s.setContractTypeCode);
  const myRole = useContractNewStore((s) => s.myRole);
  const setRole = useContractNewStore((s) => s.setRole);
  const actingAs = useContractNewStore((s) => s.actingAs);
  const setActingAs = useContractNewStore((s) => s.setActingAs);

  // Для услуги кода не нужно; для продажи/аренды/займа — список из каталога (ADR-094).
  const needsCode = clientOption !== null && clientOption !== 'service';
  const {
    data: typeOptions,
    isLoading: typesLoading,
    error: typesError,
    refetch: refetchTypes,
  } = useContractTypes(needsCode ? clientOption : null);

  // Займ — единственный код (loan_individuals): выбираем автоматически, без лишнего клика.
  useEffect(() => {
    const only = typeOptions?.length === 1 ? typeOptions[0] : undefined;
    if (needsCode && only && contractTypeCode !== only.code) {
      setContractTypeCode(only.code);
    }
  }, [needsCode, typeOptions, contractTypeCode, setContractTypeCode]);

  // Роль зафиксирована при создании черновика (в `ContractPatchSerializer` её нет).
  const roleLocked = !!draftId;

  const tiles: TypePickerTile[] = [
    { kind: 'service', title: t('contractNew.tileService.title'), desc: t('contractNew.tileService.desc'), icon: 'stages' },
    { kind: 'sale', title: t('contractNew.tileSale.title'), desc: t('contractNew.tileSale.desc'), icon: 'wallet' },
    { kind: 'rent_items', title: t('contractNew.tileRent.title'), desc: t('contractNew.tileRent.desc'), icon: 'calendar' },
    { kind: 'loan', title: t('contractNew.tileLoan.title'), desc: t('contractNew.tileLoan.desc'), icon: 'receipt' },
  ];

  function pickTile(kind: ContractKind): void {
    const option = TILE_TO_OPTION[kind];
    if (option && option !== clientOption) {
      setClientOption(option);
      setContractTypeCode(null);
    }
  }

  async function next(): Promise<void> {
    if (!clientOption) return;
    const target = clientOption === 'service' ? '../sphere' : '../parties';
    if (draftId && draft) {
      const typeChanged =
        clientOptionFromTypeCode(draft.contract_type_code) !== clientOption ||
        (needsCode && !!contractTypeCode && contractTypeCode !== draft.contract_type_code);
      const myParty = draft.parties.find((p) => p.profile_id === myProfileId);
      const actingChanged = !!myParty && myParty.acting_as !== actingAs;
      if (typeChanged || actingChanged) {
        setSaving(true);
        setServerError(null);
        try {
          await patch.mutateAsync({
            ...(typeChanged
              ? clientOption === 'service'
                ? { client_option: 'service', form_data: {} }
                : { contract_type_code: contractTypeCode ?? undefined, form_data: {} }
              : {}),
            ...(actingChanged ? { my_acting_as: actingAs } : {}),
          });
        } catch (e) {
          setServerError(e instanceof ApiError ? e.message : String(e));
          return;
        } finally {
          setSaving(false);
        }
      }
    }
    navigate(target);
  }

  const showSubtypes = needsCode && (typeOptions?.length ?? 0) > 1;
  // Блок уточнения виден и в загрузке/ошибке: «Далее» заблокирована, пока кода
  // нет — без индикации это выглядело мёртвой кнопкой (отсмотр 2026-08-18, №5/№8:
  // холодный каталог на проде отвечал до 16 с).
  const showSubtypeField = needsCode && (typesLoading || !!typesError || showSubtypes);
  const nextDisabled = !clientOption || (needsCode && !contractTypeCode);

  return (
    <>
      <h2 className={wizardStyles.stepTitle}>{t('contractNew.typeTitle')}</h2>
      <p className={wizardStyles.stepSub}>{t('contractNew.typeSub')}</p>
      <TypePicker
        value={clientOption ? OPTION_TO_TILE[clientOption] : null}
        onChange={pickTile}
        tiles={tiles}
        notYetSupportedLabel={t('contractNew.notYetSupported')}
        ariaLabel={t('contractNew.typeAriaLabel')}
      />

      {showSubtypeField ? (
        <div className={styles.field}>
          <span className={styles.fieldLabel}>{t('contractNew.subtypeLabel')}</span>
          {typesLoading ? (
            <Skeleton width="60%" height={44} />
          ) : typesError ? (
            <p className={styles.subtypeError} role="alert">
              {t('contractNew.subtypeLoadError')}
              <Button variant="ghost" onClick={() => void refetchTypes()}>
                {t('common.retry')}
              </Button>
            </p>
          ) : (
            <>
              <Segmented
                ariaLabel={t('contractNew.subtypeLabel')}
                value={contractTypeCode}
                onChange={(code) => setContractTypeCode(code)}
                items={(typeOptions ?? []).map((o) => ({
                  value: o.code,
                  label: o.name,
                  'data-testid': `subtype-${o.code}`,
                }))}
              />
              {!contractTypeCode ? (
                <p className={styles.subtypeHint} data-testid="subtype-hint">
                  {t('contractNew.subtypeHint')}
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {serverError ? (
        <p role="alert" className={wizardStyles.stepError} data-testid="type-error">
          {serverError}
        </p>
      ) : null}

      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t('contractNew.roleLabel')}</span>
        {/* Доска B: роли — тёмные пилюли, а «Далее» стоит с ними В ОДНОЙ строке
            на десктопе (справа) и уходит под них во всю ширину на телефоне. */}
        <div className={styles.roleRow}>
          <div className={styles.rolePills}>
            {/* DEV-20 §6: общий `Segmented` вместо страничных кнопок — тот же
                язык сегмента везде. */}
            <Segmented
              ariaLabel={t('contractNew.roleLabel')}
              tone="dark"
              value={myRole}
              onChange={setRole}
              disabled={roleLocked}
              items={[
                { value: 'customer' as const, label: t('contractNew.roleCustomer'), 'data-testid': 'role-customer' },
                { value: 'contractor' as const, label: t('contractNew.roleContractor'), 'data-testid': 'role-contractor' },
              ]}
            />
            <Segmented
              ariaLabel={t('actor.person')}
              tone="dark"
              value={actingAs}
              onChange={setActingAs}
              items={[
                { value: 'person' as const, label: t('actor.person'), 'data-testid': 'acting-person' },
                { value: 'business' as const, label: t('actor.business'), 'data-testid': 'acting-business' },
              ]}
            />
          </div>
          <div className={styles.roleFooter}>
            <WizardFooter onNext={() => void next()} nextDisabled={nextDisabled} nextLoading={patch.isPending} />
          </div>
        </div>
        {roleLocked ? <p className={wizardStyles.stepSub}>{t('contractNew.typeLockedHint')}</p> : null}
      </div>
    </>
  );
}
