import { useQuery } from '@tanstack/react-query';
import type { LegalDocSlug, LegalDocument } from '@porukam/core';
import { api } from '../../shared/api';

/**
 * GET /v1/legal/<doc> (docs/tasks/Задача_feat_l10n-launch-surfaces.md §B) —
 * публичный, доступен гостю на /welcome до всякого входа.
 *
 * `locale` — В КЛЮЧЕ КЭША и в запросе явным параметром: документ обязан
 * прийти на активном языке интерфейса, а не на том, который бэкенд угадает по
 * Accept-Language (заголовок огрубляет `pt-BR` → `pt`, см. docstring
 * `LegalDocumentView`). Смена языка при открытой шторке — новый ключ, то есть
 * новый запрос, а не устаревший текст на прежнем языке.
 *
 * `enabled` — запрос идёт только когда документ действительно открывают:
 * пролистать /welcome, ни разу не тронув ссылки, не должно стоить загрузки
 * двух юр-простыней.
 */
export function useLegalDocument(doc: LegalDocSlug | null, locale: string) {
  return useQuery({
    queryKey: ['legal', doc, locale],
    queryFn: () => api.request<LegalDocument>(`/legal/${doc}?locale=${encodeURIComponent(locale)}`),
    enabled: doc !== null,
    staleTime: 60 * 60_000, // юр-документ версионируется, а не меняется на ходу
  });
}
