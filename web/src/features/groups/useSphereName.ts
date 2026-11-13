import { useSpheres } from '../contractNew/api';

/** Резолвер имён сфер каталога (`GET /v1/spheres`, ADR-117 §2): один запрос на
 * компонент, сколько бы кодов ни пришлось подписать — витрина работ ADR-128
 * подписывает сферу у каждой работы, а хук на элемент списка не поставишь.
 * Код без имени в выдаче показываем как есть (лучше код, чем пустое место);
 * "" (легаси без сферы) → пусто, вызывающий решает, что показать. Ищем по
 * пустому запросу: `popular` + `results` без фильтра. */
export function useSphereNames(): (code: string) => string {
  const { data } = useSpheres('');
  return (code) => {
    if (!code) return '';
    return [...(data?.results ?? []), ...(data?.popular ?? [])].find((s) => s.code === code)?.name ?? code;
  };
}

/** Имя одной сферы — для карточки и формы объединения. */
export function useSphereName(code: string): string {
  return useSphereNames()(code);
}
