import { ProposeSheet, type RevisionSheetProps, type RevisionSheetSubmitInput, type RevisionSheetVariantInput } from './ProposeSheet';

export type { RevisionSheetProps as CounterSheetProps, RevisionSheetSubmitInput, RevisionSheetVariantInput };

/**
 * Встречная редакция (DEV-10 §3) — тот же мультивариантный шит, что и `ProposeSheet`
 * (форма идентична по спецификации); отправка закрывает исходную правку как `countered`
 * и создаёт новую от текущего пользователя (страница решает, `packages/ui` — только форма).
 */
export function CounterSheet(props: RevisionSheetProps): JSX.Element | null {
  return <ProposeSheet {...props} />;
}
