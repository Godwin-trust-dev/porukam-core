import { Disclosure, Surface } from '@porukam/ui';
import styles from './HelpPage.module.css';

/**
 * Список «вопрос → ответ» / «как сделать → шаги» (справка и FAQ).
 *
 * Замечание владельца 03.09: «текст компактно, мельче, без рамок и лишних
 * отступов, в едином стиле с новым дизайном». Поэтому пункты — не карточки,
 * а `Disclosure variant="row" flush` на одной поверхности `Surface bleed`:
 * тот же ритм строки, шеврон и hairline, что у вторичных блоков карточки
 * договора (ADR-152). Пункты раскрываются независимо — «только один открыт»
 * было ограничением прежней самодельной гармошки, а не требованием.
 */
export function HelpAccordion({ items, testId }: { items: Array<{ title: string; text: string }>; testId: string }): JSX.Element {
  return (
    <Surface bleed data-testid={testId}>
      {items.map((it) => (
        <Disclosure key={it.title} variant="row" flush label={it.title}>
          <p className={styles.answer}>{it.text}</p>
        </Disclosure>
      ))}
    </Surface>
  );
}
