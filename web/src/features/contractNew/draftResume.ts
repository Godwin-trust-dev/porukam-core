import type { RealContract } from '@porukam/core';
import { useContractNewStore, type ClientOption } from './draftStore';

/**
 * Возврат в мастер к существующему черновику (ADR-104: «черновик надо
 * редактировать, а не плодить новые»). Каталожный контекст мастера живёт
 * в памяти (`draftStore`) и после ухода со страницы сбрасывается — здесь он
 * восстанавливается из самого договора: тип → опция клиентского дерева
 * (docs/catalog-v2.md §1: код типа начинается с опции), сфера — из
 * `form_data.sphere_code`, роль/кем выступаю — из своей стороны.
 */
export function clientOptionFromTypeCode(code: string): ClientOption | null {
  if (code.startsWith('services_')) return 'service';
  if (code.startsWith('sale_')) return 'sale';
  if (code.startsWith('rent_')) return 'rent';
  if (code.startsWith('loan_')) return 'loan';
  return null;
}

/** Путь к мастеру для кнопки «Редактировать» у черновика. */
export function draftEditPath(contractId: string): string {
  return `/contracts/new/details?draft=${contractId}`;
}

export function seedStoreFromDraft(contract: RealContract, myProfileId: string | null): void {
  const store = useContractNewStore.getState();
  const option = clientOptionFromTypeCode(contract.contract_type_code);
  const me = contract.parties.find((p) => p.profile_id === myProfileId);
  store.reset();
  store.setDraftId(contract.id);
  if (option) store.setClientOption(option);
  store.setContractTypeCode(option === 'service' ? null : contract.contract_type_code);
  const sphereCode = String(contract.form_data.sphere_code ?? '');
  const sphereName = String(contract.form_data.sphere_name ?? sphereCode);
  if (sphereCode) store.setSphere(sphereName, sphereCode);
  if (me) {
    store.setRole(me.role);
    store.setActingAs(me.acting_as);
  }
}
