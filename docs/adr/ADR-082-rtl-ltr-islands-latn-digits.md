# ADR-082. RTL-enablement (частично): LTR-островки, латинские цифры юрзначимых величин, Storybook dir-тумблер

**Статус:** принято
**Дата:** 2026-08-11
**Контекст этапа:** DEV-16c (`docs/tasks/DEV-16c_rtl-enablement-аудит.md`), ветка `feat/web-rtl`,
поверх DEV-16/16a/16b (ADR-079/080, уже в `main`).

## Контекст

DEV-16c ставит полный RTL-enablement (включение `ar/fa/he`, зеркалирование всех
компонентов, сквозной аудит по экранам) — но сам документ пиннит: «Запускать при выходе
на RTL-рынок. До того из этой задачи сразу берём §5 (псевдо-RTL CI-гейт) и §2
(островки)». Локали `ar/fa/he` уже заведены в моке `/v1/locales`
(`web/src/mocks/localesDb.ts`) с `enabled:false, dir:'rtl'` и статически перечислены в
`RTL_LOCALES` (`packages/i18n/src/dir.ts`, `useHtmlLangDir` уже держит `<html dir>` в
синхроне с языком) — фундамент DEV-16 §6 полностью готов. Эта ветка НЕ включает
`enabled:true` (реальное появление ar/fa/he в переключателе) и НЕ проводит full-screen
RTL-аудит (DEV-16c §1, §3, §6) — только §2 (LTR-островки) и §5 (Storybook-тумблер), плюс
смежное решение по числам, обнаруженное по пути.

По ходу работы над §2 (что именно должно быть LTR-островком) всплыл соседний пробел:
сумма договора/дата в разных локалях **выглядит по-разному** — `Intl` по умолчанию
отдаёт восточно-арабские цифры в `ar`, персидские — в `fa`. Юрзначимая величина (сумма
договора, дата подписания, срок) не может визуально различаться у двух сторон одной
сделки — это не косметика локали. Решение зафиксировано как обновление DEV-16 §5.

## Решения

### 1. LTR-островки — систематически на всех местах, перечисленных в DEV-16c §2

`<LtrText dir="ltr">` (`packages/ui/src/components/LtrText.tsx`, уже существовал для
`integrity_hash`/`@handle` — DEV-16 §6/DEV-16a) применён на каждом рендер-сайте
`formatMoney`/`formatPolicyMoney` (⁓20 компонентов `packages/ui` + `web/src/pages`:
`MoneyBreakdown`, `MoneyPanel`, `ContractHeader`, `ContractRow`, `Card`, `StageRow`,
`StageTree`, `SectionHeader`, `PaymentModal`, `PaymentPlan`, `PreviewStep`, `TrustNumber`,
`SphereRow`, `AmendmentsBlock`, `ContractListRow`, `NotificationItem`,
`CommissionSection`, `FeePaymentSbp`, `PaymentBreakdown`, `SbpPay`, `ReviewDocument`,
`AttentionCard.urgency.value` — включая таймеры/дедлайны через `formatCountdown`) и на
юрзначимых датах/timestamp'ах (см. §2 ниже). Компоненты, которые принимают уже
отформатированную строку через prop (`amountLabel`/`s.amountLabel`/`urgency.value`) —
оборачивают её сами, в точке рендера (не вызывающая страница) — тот же принцип, что уже
был у `FrozenVersion`/`PassportHeader`.

**Не тронуто (сознательно, отдельный шаг DEV-16c §4):** money/дата, встроенные в
i18next-интерполяцию строки (`t('key', { time: formatCountdown(...) })` —
`StagePage.tsx` timerValue) — обернуть только цифровой сегмент внутри переведённого
предложения требует `<Trans>` вместо простой интерполяции, это отдельная, более
инвазивная правка по всем интерполированным строкам (bidi-строки, DEV-16c §4), не мешаем
в этот PR с механическим оборачиванием отдельных JSX-узлов.

### 2. Латинские цифры для юрзначимых величин — DEV-16 §5 (обновлено 10.08)

`packages/core/src/format.ts`:
- `formatMoney`/`formatPolicyMoney` — `numberingSystem: 'latn'` **всегда**, безусловно
  (валютный символ/decimals/порядок остаются по локали — только цифры фиксированы).
- `formatDate`/`formatDateTime` — новый необязательный 4-й параметр
  `opts?: { legal?: boolean }`; `{ legal: true }` → `numberingSystem: 'latn'`. Обычные
  (неюридические) даты — без опции, по локали, как раньше.
- `useFormatters()` (`web/src/shared/formatters.ts`) прокидывает `opts` в оба хелпера.

`{ legal: true }` расставлен на всех датах, которые ТЗ называет юрзначимыми (срок
договора, дата подписания/TSA, сроки приёмки-оплаты): `ContractPage` (даты
начало/окончание/ближайший срок), `SigningPage` (версия, TSA в церемонии),
`ContractDetailPage` (TSA-время версии), `StagePage` (дедлайн этапа, таймер приёмки),
`FrozenVersion`/`PartyRow`/`SignatureRow` (TSA/дата подписи — они дергают `formatDateTime`
напрямую из `@porukam/core`, а не через `useFormatters()`, т.к. живут в `packages/ui` без
доступа к `i18n.language`; это уже существовавшее ограничение этих трёх компонентов, не
новое — они и раньше форматировали в `DEFAULT_LOCALE`, не в языке интерфейса).
Операционные даты (лента уведомлений, таймстемпы событий/загрузок, сессии в настройках) —
намеренно НЕ помечены `legal` — это украшение локали, не юридическое значение.

Одновременно эти же значения — LTR-островки (§1) в RTL: в арабской/фарси-раскладке они
не зеркалятся и остаются в latn — оба решения работают вместе (см. заголовок
`format.ts`).

### 3. Storybook — глобальный тумблер `dir` (ltr/rtl/pseudo)

`packages/ui/.storybook/preview.tsx` (переименован из `.ts` — понадобился JSX):
`globalTypes.dir` — тулбар с тремя значениями. `ltr`/`rtl` оборачивают историю в
`<div dir="...">`. `pseudo` — НЕ RTL (тот же принцип, что `en-XA`,
`packages/i18n/src/pseudo.ts`): пропускает строковые пропы истории через `pseudoize()`
(реэкспортирован из `@porukam/i18n`, уже был `devDependency` пакета `ui`) и рендерит
`Story({ args: pseudoizedArgs })` — растянутые/утяжелённые строки для визуальной
bidi/overflow-проверки конкретного компонента без переключения языка интерфейса.

Реальный «стоячий гейт» псевдолокали — не здесь, а в `web/tests/e2e/pseudolocale.spec.ts`
(уже существовал, DEV-16 §1): он входит в `npm run test:e2e -w web`, то есть попадёт в CI
автоматически, когда будет закрыта `chore-web-ci.md` (CI для `web/` пока не заведён вообще
— отдельная, уже поставленная задача, не блокер этой ветки).

## Последствия

- **Вне скоупа этого ADR (осознанно, ждёт волны B3 по DEV-16c):** `enabled:true` для
  `ar/fa/he` в `/v1/locales`; арабский/ивритский шрифтовой фолбэк (DEV-16c §1); зеркала
  компонентов сверх LTR-островков — степперы/шиты/сегмент-контролы (§3); bidi-строки
  внутри i18next-интерполяции (§4); сквозной аудит по экранам (§6). Флаги/данные под это
  уже готовы (`RTL_LOCALES`, `dirForLocale`, `useHtmlLangDir`, мок `/v1/locales`) —
  включение остаётся тремя `enabled:true` плюс аудитом, не структурной переделкой.
- Любой новый money/date-компонент обязан заворачивать юрзначимые рендеры в `<LtrText>` и
  юрдаты — в `formatDate/formatDateTime(..., { legal: true })`; это теперь проверяемый
  паттерн (юнит-тесты на `dir="ltr"` в `web/tests/Signing.components.test.tsx`,
  `ContractCard.components.test.tsx`; юнит-тесты `numberingSystem` в
  `packages/core/tests/format.test.ts`), а не факультативный.
- `FrozenVersion`/`PartyRow`/`SignatureRow` форматируют TSA/дату подписи в
  `DEFAULT_LOCALE`, не в языке интерфейса пользователя — существовавший пробел (не
  предмет DEV-16c), фиксируем как известный хвост, не потянутый в этот PR.
