import { useMemo } from 'react';
import { useWarrantyClaims } from '../disputes/api';

/**
 * Договоры, по которым ПРЯМО СЕЙЧАС открыт гарантийный случай.
 *
 * Решение владельца 31.08: гарантийный период — архив (сделка исполнена,
 * делать нечего), но с момента подачи заявки по договору снова идёт работа,
 * и он возвращается в «Активные»; закрыли заявку — уходит обратно в архив.
 * Реальный бэк отдельного статуса не заводит (`execution_status` — единый
 * `warranty`, см. `realStatus.ts`), поэтому признак приходит СПИСКОМ заявок:
 * `GET /v1/warranty-claims` уже используется разделом «Разногласия», нового
 * запроса к бэку не появляется — react-query отдаёт тот же кэш по ключу.
 *
 * Пустое множество, пока список не загружен или запрос упал: сделка тогда
 * остаётся в архиве, где она и была, — это тише, чем прыгающая корзина.
 */
export function useOpenWarrantyClaims(): ReadonlySet<string> {
  const { data } = useWarrantyClaims();
  return useMemo(
    () => new Set((data ?? []).filter((claim) => claim.status !== 'resolved').map((claim) => claim.contract_id)),
    [data],
  );
}
