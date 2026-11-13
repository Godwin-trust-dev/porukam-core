import { type ReactNode } from 'react';
import styles from './MarkdownDocument.module.css';

export interface MarkdownDocumentProps {
  /** Тело документа в markdown-подмножестве (см. docstring ниже). */
  source: string;
  className?: string;
}

/**
 * Рендер юр-документа платформы (docs/tasks/Задача_feat_l10n-launch-surfaces.md
 * §B) — ПОДМНОЖЕСТВО markdown, ровно то, что встречается в `docs/legal/`:
 * `# `/`## ` заголовки, абзацы (одиночный перевод строки внутри абзаца — как
 * `<br>`: так свёрстана шапка «**Сервис:** … / **Оператор:** …»), списки `- `,
 * таблицы `|…|`, разделитель `---`, цитата `> `, и инлайново `**жирный**`,
 * `[текст](ссылка)`, `` `код` ``.
 *
 * Почему свой рендер, а не библиотека: единственный источник этих документов —
 * `docs/legal/` в самом репозитории (не пользовательский ввод), подмножество
 * закрыто и проверяется скриптом слияния (`l10n/merge_legal.py` сверяет число
 * разделов и строк таблиц с эталоном), а `dangerouslySetInnerHTML` здесь не
 * появляется вовсе — рендерим React-узлами. Новая зависимость ради этого не
 * нужна, а markdown-парсер общего назначения принёс бы и HTML-проходку, и
 * необходимость санитайзера.
 *
 * Неизвестная разметка не теряется: строка, не подошедшая ни под одно
 * правило, рендерится как обычный абзац — документ никогда не пропадает
 * молча, максимум покажет лишний символ.
 */
export function MarkdownDocument({ source, className }: MarkdownDocumentProps): JSX.Element {
  return (
    <div className={`${styles.doc} ${className ?? ''}`}>{renderBlocks(source)}</div>
  );
}

// --- блочный разбор ------------------------------------------------------

const TABLE_ROW = /^\s*\|(.*)\|\s*$/;
// Строка-разделитель шапки таблицы: |---|---| (с необязательными двоеточиями).
const TABLE_DIVIDER = /^\s*\|[\s:|-]+\|\s*$/;
const HR = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

function renderBlocks(source: string): ReactNode[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (HR.test(line)) {
      out.push(<hr key={key++} className={styles.rule} />);
      i += 1;
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const text = heading[2] ?? '';
      const Tag = (['h1', 'h2', 'h3', 'h4'] as const)[level - 1] ?? 'h4';
      out.push(
        <Tag key={key++} className={styles[Tag]}>
          {renderInline(text)}
        </Tag>,
      );
      i += 1;
      continue;
    }

    if (line.trimStart().startsWith('> ')) {
      const quote: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trimStart().startsWith('> ')) {
        quote.push((lines[i] ?? '').trimStart().slice(2));
        i += 1;
      }
      out.push(
        <blockquote key={key++} className={styles.quote}>
          {renderInline(quote.join(' '))}
        </blockquote>,
      );
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? '') && !HR.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*[-*]\s+/, ''));
        i += 1;
      }
      out.push(
        <ul key={key++} className={styles.list}>
          {items.map((item, index) => (
            <li key={index}>{renderInline(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (TABLE_ROW.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i] ?? '')) {
        const raw = lines[i] ?? '';
        i += 1;
        if (TABLE_DIVIDER.test(raw)) continue;
        const cells = (TABLE_ROW.exec(raw)?.[1] ?? '').split('|').map((c) => c.trim());
        rows.push(cells);
      }
      const [head, ...body] = rows;
      out.push(
        // Обёртка со своим горизонтальным скроллом: таблица юр-документа шире
        // узкой модалки на телефоне, и скроллить должна ОНА, а не страница.
        <div key={key++} className={styles.tableWrap}>
          <table className={styles.table}>
            {head ? (
              <thead>
                <tr>
                  {head.map((cell, index) => (
                    <th key={index}>{renderInline(cell)}</th>
                  ))}
                </tr>
              </thead>
            ) : null}
            <tbody>
              {body.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{renderInline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Абзац: до пустой строки или до начала другого блока.
    const paragraph: string[] = [];
    while (i < lines.length) {
      const next = lines[i] ?? '';
      if (
        !next.trim() ||
        HR.test(next) ||
        /^#{1,4}\s+/.test(next) ||
        /^\s*[-*]\s+/.test(next) ||
        TABLE_ROW.test(next) ||
        next.trimStart().startsWith('> ')
      ) {
        break;
      }
      paragraph.push(next);
      i += 1;
    }
    out.push(
      <p key={key++} className={styles.paragraph}>
        {paragraph.map((text, index) => (
          <span key={index}>
            {index > 0 ? <br /> : null}
            {renderInline(text)}
          </span>
        ))}
      </p>,
    );
  }

  return out;
}

// --- инлайновый разбор ---------------------------------------------------

// Порядок альтернатив важен: `код` раньше **жирного**, чтобы звёздочки внутри
// кода не съедались; ссылка — до и того и другого (её текст может быть жирным,
// но вложенность внутрь ссылки нам не нужна, а вот `[**x**](y)` не должен
// развалиться на части).
const INLINE = /(\[[^\]]+\]\([^)\s]+\))|(`[^`]+`)|(\*\*[^*]+\*\*)/g;

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > cursor) out.push(text.slice(cursor, start));
    const token = match[0];

    if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const label = link?.[1] ?? token;
      const href = link?.[2] ?? '#';
      out.push(
        // Юр-документы ссылаются на внешние страницы (Google API policy,
        // myaccount.google.com) — новая вкладка + noreferrer, чтобы человек
        // не терял открытый документ и незавершённый онбординг.
        <a key={key++} className={styles.link} href={href} target="_blank" rel="noreferrer noopener">
          {label}
        </a>,
      );
    } else if (token.startsWith('`')) {
      out.push(
        <code key={key++} className={styles.code}>
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      out.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    }
    cursor = start + token.length;
  }

  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}
