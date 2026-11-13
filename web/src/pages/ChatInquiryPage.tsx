import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ApiError, type ContractKind, type HandleEntry } from '@porukam/core';
import { Button, Card, TextArea, TextField, TypePicker, useDesktopLayout, type TypePickerTile } from '@porukam/ui';
import { useSavedContacts } from '../features/contacts/api';
import { useHandleSearch } from '../features/contracts/api';
import { useContractTypes } from '../features/contractNew/api';
import type { ClientOption } from '../features/contractNew/draftStore';
import { useCreateRealContract } from '../features/contracts/realApi';
import { api } from '../shared/api';
import typeStyles from './contract-new/TypeStep.module.css';
import styles from './ChatInquiryPage.module.css';

/** Плитка UI ↔ опция клиентского дерева — та же пара, что в TypeStep (ADR-094). */
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
 * `/chat/new` — «Запрос на сотрудничество» (ADR-116): переговоры начинаются
 * с вопроса, а не с заполненного договора. Мини-форма «кому + тип работы +
 * сообщение по шаблону» под капотом создаёт МИНИМАЛЬНЫЙ черновик договора
 * (контрагент — полноценная сторона с момента создания, ADR-088) и шлёт
 * первое сообщение в его чат — дальше обычные переговоры ADR-112, чат
 * остаётся договорным, переписка с первого слова в доказательной базе.
 * Тип работы обязателен: инвариант мастера (create требует тип) не ослабляем,
 * а название черновика берётся из выбранного типа — иначе тред в списке
 * диалогов остался бы без заголовка.
 */
export function ChatInquiryPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isDesktop = useDesktopLayout();

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<{ handle: string; display_name: string } | null>(null);
  const [myRole, setMyRole] = useState<'customer' | 'contractor'>('customer');
  const [clientOption, setClientOption] = useState<ClientOption | null>(null);
  const [contractTypeCode, setContractTypeCode] = useState<string | null>(null);
  const [message, setMessage] = useState<string>(() => '');
  const [messageTouched, setMessageTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const searchQuery = query.trim();
  const search = useHandleSearch(searchQuery);
  const contacts = useSavedContacts();

  const needsCode = clientOption !== null && clientOption !== 'service';
  const { data: typeOptions, isLoading: typesLoading } = useContractTypes(needsCode ? clientOption : null);
  // Займ — единственный код: выбирается сам, как в TypeStep.
  const onlyOption = typeOptions?.length === 1 ? typeOptions[0] : undefined;
  useEffect(() => {
    if (needsCode && onlyOption && contractTypeCode !== onlyOption.code) {
      setContractTypeCode(onlyOption.code);
    }
  }, [needsCode, onlyOption, contractTypeCode]);

  // Шаблон — подставляется, пока человек не начал править текст сам.
  const template = t('contract.chat.inquiryTemplate');
  const effectiveMessage = messageTouched ? message : template;

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

  const contactChips = (contacts.data ?? []).filter((c) => c.target_handle);
  const results = searchQuery && !selected ? (search.data ?? []) : [];

  const create = useCreateRealContract();
  const canSubmit =
    !!selected && !!clientOption && (!needsCode || !!contractTypeCode) && effectiveMessage.trim().length > 0 && !sending;

  async function submit(): Promise<void> {
    if (!selected || !clientOption || !canSubmit) return;
    setSending(true);
    setSubmitError(null);
    try {
      const title = needsCode
        ? (typeOptions?.find((o) => o.code === contractTypeCode)?.name ?? '')
        : t('contractNew.tileService.title');
      const contract = await create.mutateAsync({
        my_role: myRole,
        my_acting_as: 'person',
        ...(clientOption === 'service'
          ? { client_option: 'service' }
          : { contract_type_code: contractTypeCode ?? undefined }),
        counterparty_handle: selected.handle,
        title,
      });
      try {
        await api.request(`/contracts/${contract.id}/messages`, {
          method: 'POST',
          body: { body: effectiveMessage.trim() },
        });
      } catch {
        // Черновик уже создан — ведём в тред, сообщение можно отправить там.
      }
      navigate(isDesktop ? `/chat?sel=${contract.id}` : `/chat/${contract.id}`);
    } catch (e) {
      setSubmitError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <Card>
      <div className={styles.wrap} data-testid="chat-inquiry">
        <h2 className={styles.title}>{t('contract.chat.inquiryTitle')}</h2>
        <p className={styles.sub}>{t('contract.chat.inquirySub')}</p>

        <div className={typeStyles.field}>
          {selected ? (
            <div className={styles.selectedRow}>
              <span className={styles.selectedName}>
                {selected.display_name} <span className={styles.selectedHandle}>{selected.handle}</span>
              </span>
              <Button variant="ghost" onClick={() => setSelected(null)}>
                {t('contract.chat.inquiryChange')}
              </Button>
            </div>
          ) : (
            <>
              <TextField
                label={t('contract.chat.inquiryCounterpartyLabel')}
                placeholder={t('contract.chat.inquirySearchPlaceholder')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                data-testid="inquiry-search"
              />
              {results.length > 0 ? (
                <ul className={styles.results} data-testid="inquiry-results">
                  {results.slice(0, 6).map((h: HandleEntry) => (
                    <li key={h.handle}>
                      <button
                        type="button"
                        className={styles.resultRow}
                        onClick={() => setSelected({ handle: h.handle, display_name: h.display_name })}
                      >
                        <span>{h.display_name}</span>
                        <span className={styles.selectedHandle}>{h.handle}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {contactChips.length > 0 ? (
                <div className={styles.contacts}>
                  <span className={styles.contactsLabel}>{t('contract.chat.inquiryFromContacts')}</span>
                  <div className={styles.chips}>
                    {contactChips.slice(0, 8).map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className={styles.chip}
                        onClick={() =>
                          setSelected({
                            handle: c.target_handle ?? '',
                            display_name: c.display_name ?? c.target_display_name,
                          })
                        }
                      >
                        {c.display_name ?? c.target_display_name}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>

        <div className={typeStyles.field}>
          <span className={typeStyles.fieldLabel}>{t('contractNew.roleLabel')}</span>
          <div className={typeStyles.segmented} role="group" aria-label={t('contractNew.roleLabel')}>
            {(['customer', 'contractor'] as const).map((r) => (
              <button
                key={r}
                type="button"
                className={`${typeStyles.segBtn} ${myRole === r ? typeStyles.segBtnActive : ''}`}
                onClick={() => setMyRole(r)}
              >
                {t(r === 'customer' ? 'contractNew.roleCustomer' : 'contractNew.roleContractor')}
              </button>
            ))}
          </div>
        </div>

        <TypePicker
          value={clientOption ? OPTION_TO_TILE[clientOption] : null}
          onChange={pickTile}
          tiles={tiles}
          notYetSupportedLabel={t('contractNew.notYetSupported')}
          ariaLabel={t('contractNew.typeAriaLabel')}
        />

        {needsCode && (typeOptions?.length ?? 0) > 1 ? (
          <div className={typeStyles.field}>
            <span className={typeStyles.fieldLabel}>{t('contractNew.subtypeLabel')}</span>
            <div className={typeStyles.segmented} role="group" aria-label={t('contractNew.subtypeLabel')}>
              {(typeOptions ?? []).map((o) => (
                <button
                  key={o.code}
                  type="button"
                  className={`${typeStyles.segBtn} ${contractTypeCode === o.code ? typeStyles.segBtnActive : ''}`}
                  onClick={() => setContractTypeCode(o.code)}
                >
                  {o.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {needsCode && typesLoading ? <p className={styles.sub}>{t('common.loading')}</p> : null}

        <TextArea
          label={t('contract.chat.inquiryMessageLabel')}
          value={effectiveMessage}
          rows={4}
          onChange={(e) => {
            setMessageTouched(true);
            setMessage(e.target.value);
          }}
          data-testid="inquiry-message"
        />

        {submitError ? (
          <p role="alert" className={styles.error}>
            {submitError}
          </p>
        ) : null}

        <div className={styles.actions}>
          <Button variant="ghost" onClick={() => navigate('/chat')}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!canSubmit} loading={sending} data-testid="inquiry-submit">
            {t('contract.chat.inquirySend')}
          </Button>
        </div>
      </div>
    </Card>
  );
}
