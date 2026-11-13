/**
 * Английский демо-набор фикстур для витринных скриншотов (Google Play / App Store).
 *
 * Зачем отдельным слоем, а не второй мок-БД: сиды моков — русские и остаются
 * источником истины для всех e2e/юнитов (дефолт НЕ меняется). Витрине нужен тот
 * же самый экран, но с английскими данными, поэтому здесь — ПОДМЕНА СТРОК поверх
 * уже собранных сидов: словарь «русская строка → английская» + пересчёт денег.
 * Дублировать 4000 строк `realContractsDb` ради восьми кадров было бы дороже и
 * разъехалось бы с боевыми сидами на первой же правке.
 *
 * Включается флагом (только dev/mock-сборка):
 *   localStorage['porukam.mockData'] === 'en'   — как ставит спек витрины;
 *   ?mockData=en в адресе — тот же флаг, руками из браузера (запоминается).
 * Без флага `isDemoEn()` === false и ни одна фикстура не трогается.
 *
 * Деньги: пара (amount, currency) остаётся парой — валюта RUB → USD, сумма
 * делится на DEMO_MONEY_DIVISOR. Делитель ЛИНЕЕН, поэтому инвариант «сумма
 * листьев = сумма договора» сохраняется; 20 выбран так, чтобы round-суммы
 * рублёвых сидов давали ровные центы (18000.00 ₽ → 900.00 $).
 */

const FLAG_KEY = 'porukam.mockData';

/** 1 USD ≈ 20 «мок-рублей»: см. докстринг модуля (линейность важнее курса). */
const DEMO_MONEY_DIVISOR = 20;

/** Язык витринного демо-набора: `en` — перевод сидов (Google Play), `ru` — те же
 * русские сиды, но в витринном виде (RuStore): без контура споров, с живой
 * перепиской, разными контрагентами и нейтральными именами. */
export type DemoLang = 'en' | 'ru';

let flag: DemoLang | null | undefined;

function readDemoLang(): DemoLang | null {
  try {
    const search = typeof location !== 'undefined' ? location.search : '';
    const fromUrl = search ? new URLSearchParams(search).get('mockData') : null;
    if (fromUrl === 'en' || fromUrl === 'ru') localStorage.setItem(FLAG_KEY, fromUrl);
    const stored = localStorage.getItem(FLAG_KEY);
    return stored === 'en' || stored === 'ru' ? stored : null;
  } catch {
    // приватный режим/SSR — демо-набор просто не включается
    return null;
  }
}

/** Флаг демо-набора. Читается один раз за загрузку вкладки. */
export function demoLang(): DemoLang | null {
  if (flag === undefined) flag = readDemoLang();
  return flag;
}

/** Английский демо-набор (перевод строк и денег). */
export function isDemoEn(): boolean {
  return demoLang() === 'en';
}

/** Любой витринный демо-набор — EN или RU. */
export function isDemoStore(): boolean {
  return demoLang() !== null;
}

/** Сброс кэша флага — только для тестов. */
export function resetDemoEnFlag(): void {
  flag = undefined;
}

/** Русские строки, для которых английского перевода ещё нет: видно в консоли
 * dev-сборки, чтобы словарь пополнялся по факту, а не наугад. */
export const demoEnMissing = new Set<string>();

/** Ключи, значение которых — денежная сумма строкой. */
const MONEY_KEY = /(^|_)(amount|price|total|sum)$/i;
const MONEY_VALUE = /^-?\d+(\.\d{1,2})?$/;

const CYRILLIC = /[А-Яа-яЁё]/;

function scaleMoney(value: string): string {
  const cents = Math.round(Number(value) * 100);
  return (Math.round(cents / DEMO_MONEY_DIVISOR) / 100).toFixed(2);
}

/** Составные строки, которые в словарь целиком не положишь (шаблоны сидов). */
const PHRASES: [RegExp, string][] = [
  [/^Этап (\d+) принят заказчиком$/, 'Stage $1 accepted by the customer'],
  [/^Допсоглашение №(\d+)$/, 'Amendment No. $1'],
  [/^Спор по этапу «(.+)»$/, 'Dispute on stage “$1”'],
];

/** Словарь фикстур: точное совпадение строки. Ключи — как в русских сидах. */
const DICT: Record<string, string> = {
  // ── валюта ──
  // EUR, а не USD: общий `formatMoney` ставит символ ПОСЛЕ суммы («9 000 €»),
  // и для доллара такой порядок читался бы неверно.
  RUB: 'EUR',

  // ── люди, профили, организации ──
  'Годвин': 'Daniel Reyes',
  'Годвин (физлицо)': 'Daniel Reyes (personal)',
  'ИП Годвин': 'Reyes Studio',
  'ИП Годвин · «Тёплый ремонт»': 'Reyes Studio · sole proprietor',
  'СтройБыт': 'Northgate Build',
  'Марат Отделкин': 'Mia Chen',
  'Мастер Ремонт': 'Anna Berg',
  'Артём Половцев': 'Lucas Weber',
  'Ирина Соколова': 'Sofia Rossi',
  'Николай Гром': 'Noah Grant',
  'ООО «СветДом»': 'Lumen Home LLC',
  'Мария Заказчикова': 'Maria Silva',
  'Артём Ковалёв': 'Adam Cole',
  'Пётр Закрытый': 'Peter Quinn',
  'Мастера отделки': 'Finish Masters',
  'Дмитрий Косяк': 'Ethan Ward',
  'Анна Свет': 'Ella Novak',
  'Игорь Волков': 'Owen Fisher',
  'Марина Литвак': 'Nora Lang',
  'Олег Т.': 'Oliver T.',
  'Павел Ключ': 'Paul Keene',
  'Роман Высотов': 'Roman Hale',
  'Семья Верещагиных': 'The Harper family',
  'СтройМастер': 'BuildMaster',
  'ТеплоСервис': 'ThermoCare',
  'Отделка+': 'FinishPlus',
  'Мария Соколова': 'Maria Stone',
  'Москва': 'Portland',
  'Алматы': 'Portland',
  'Алматы, ул. Абая, 10, кв. 5': '12 Maple Street, Apt 5, Portland',
  '+7 900 •••-••-34': '+1 555 •••-••-34',

  // ── названия сделок ──
  'Ремонт кухни.': 'Kitchen renovation',
  'Ремонт кухни': 'Kitchen renovation',
  'Ремонт кухни, 12 м²': 'Kitchen renovation, 12 m²',
  'Сборка мебели — гостиная': 'Furniture assembly — living room',
  'Сборка мебели, гостиная': 'Furniture assembly, living room',
  'Сборка мебели, спальня': 'Furniture assembly, bedroom',
  'Сборка мебели, 3 комплекта': 'Furniture assembly, 3 sets',
  'Ремонт ванной комнаты': 'Bathroom renovation',
  'Ремонт ванной комнаты «под ключ»': 'Full bathroom renovation',
  'Укладка ламината в спальне': 'Laminate flooring — bedroom',
  'Укладка ламината, 42 м²': 'Laminate flooring, 42 m²',
  'Установка окон': 'Window installation',
  'Дизайн-проект кухни': 'Kitchen design project',
  'Установка забора': 'Fence installation',
  'Покраска забора': 'Fence painting',
  'Поклейка обоев в спальне': 'Wallpaper — bedroom',
  'Поклейка обоев, две комнаты': 'Wallpaper, two rooms',
  'Электрика в прихожей': 'Hallway wiring',
  'Электромонтаж в новостройке': 'Wiring in a new build',
  'Электрика, частный дом': 'Electrical, private house',
  'Ремонт офиса': 'Office refresh',
  'Отделка торгового зала': 'Showroom finishing',
  'Продажа велосипеда': 'Bicycle sale',
  'Аренда квартиры на Абая': 'Apartment rent on Maple Street',
  'Заём на ремонт': 'Renovation loan',
  'Ремонт балкона': 'Balcony repair',
  'Ремонт крана на кухне': 'Kitchen tap repair',
  'Обмерный план квартиры': 'Apartment measurement plan',
  'Гидроизоляция и стяжка пола': 'Waterproofing and floor screed',
  'Демонтаж старой плитки': 'Old tile removal',
  'Замена смесителя и подводки': 'Mixer tap and hose replacement',
  'Монтаж системы отопления, дом 120 м²': 'Heating system, 120 m² house',
  'Натяжные потолки, 3 помещения': 'Stretch ceilings, 3 rooms',
  'Покраска фасада балкона': 'Balcony facade painting',
  'Сборка и навеска кухонных шкафов': 'Kitchen cabinets assembly and mounting',
  'Сборка кухонного гарнитура': 'Kitchen cabinet set assembly',
  'Установка межкомнатных дверей, 4 шт': 'Interior doors, 4 pcs',
  'Штукатурка стен под покраску': 'Wall plastering for painting',
  'Велосипед Merida Big Nine 300': 'Bicycle Merida Big Nine 300',
  'Велосипед, комплект ключей, насос.': 'Bicycle, tool set, pump.',
  'Горный велосипед, рама 19", пробег около 900 км.':
    'Hardtail mountain bike, 19" frame, about 900 km ridden.',
  'Царапина на верхней трубе рамы, потёртости на грипсах.':
    'Scratch on the top tube, worn grips.',

  // ── этапы ──
  'Шкаф-купе': 'Wardrobe',
  'Стеллаж': 'Shelving unit',
  'Плитка': 'Tiling',
  'Плитка керамическая': 'Ceramic tile',
  'Подложка и укладка': 'Underlay and laying',
  'Остекление': 'Glazing',
  'Уборка': 'Cleanup',
  'Планировка': 'Layout plan',
  'Столбы и секции': 'Posts and panels',
  'Забор': 'Fence',
  'Окна': 'Windows',
  'Обои': 'Wallpaper',
  'Проводка': 'Wiring',
  'Ремонт': 'Renovation',
  'Отделка': 'Finishing',
  'Передача велосипеда': 'Bicycle handover',
  'Первый месяц аренды': 'First month of rent',
  'Возврат займа': 'Loan repayment',
  'Демонтаж': 'Demolition',
  'Демонтаж перегородки': 'Partition demolition',
  'Вывоз мусора': 'Debris removal',
  'Стены': 'Walls',
  'Стяжка пола': 'Floor screed',
  'Штукатурка стен': 'Wall plastering',
  'Замер и смета': 'Survey and estimate',
  'Поклейка обоев': 'Wallpapering',
  'Сантехника': 'Plumbing',
  'Электрика': 'Electrical',

  // ── чек-листы и доказательства ──
  'Двери открываются без перекоса': 'Doors open without skew',
  'Зазор ≤ 2мм по всей высоте': 'Gap ≤ 2 mm along the full height',
  'Швы затёрты ровно': 'Grout lines are even',
  'Швы совпадают, нет пузырей': 'Seams aligned, no bubbles',
  'Без зазоров по всей плоскости': 'No gaps across the whole surface',
  'Визуально ровно по всей стене': 'Visually even across the wall',
  'Нет отслоений на углах': 'No peeling at the corners',
  'Углы проклеены': 'Corners glued',
  'Швы не затёрты по всей длине': 'Grout missing along part of the seam',
  'Плитка уложена без пустот (простукивание)': 'Tiles laid with no voids (tap test)',
  'Швы затёрты равномерно, зазор ≤ 2 мм': 'Grout even, gap ≤ 2 mm',
  'Зазор у стен 8–10 мм соблюдён': 'Wall gap kept at 8–10 mm',
  'Стыки без расхождений, замки защёлкнуты': 'Joints tight, locks clicked in',
  'Полотна без пузырей и отслоений': 'Sheets free of bubbles and peeling',
  'Рисунок совмещён на стыках': 'Pattern matched at the seams',
  'Работа выполнена согласно описанию этапа': 'Work matches the stage description',
  'фото': 'photo',
  'стена-1.jpg': 'wall-1.jpg',
  'Стена после шпаклёвки, левый угол': 'Wall after filling, left corner',
  'Скидка по разногласию: полоса затирки у окна': 'Discount for the grout strip by the window',
  'Скидка закрывает только полосу затирки у окна и не снимает прочих требований.':
    'The discount covers only the grout strip by the window and waives nothing else.',

  // ── условия и описания ──
  'Собрать шкаф-купе и стеллаж по чертежам заказчика, вынести упаковку.':
    'Assemble a wardrobe and a shelving unit from the customer drawings, take the packaging away.',
  'Шумные работы — только с 10:00 до 18:00 по будням.':
    'Noisy work only between 10:00 and 18:00 on weekdays.',
  'Уточнение режима работ по просьбе соседей': 'Working-hours change requested by the neighbours',
  'Возвращается в течение 5 дней после сдачи квартиры по акту.':
    'Returned within 5 days after the apartment handover report.',
  'Перевод по номеру телефона, чек прикладываем в доказательства.':
    'Transfer by phone number, the receipt goes into the evidence.',
  'Свидетельство о праве собственности от 12.03.2021': 'Certificate of ownership dated 12.03.2021',
  'Срок приёмки — 5 дней с размещения в ЛК': 'Acceptance window — 5 days from delivery to the cabinet',
  'Заказчик принял этап без замечаний': 'The customer accepted the stage with no remarks',
  'Черновик: перенос срока по второму этапу': 'Draft: new date for the second stage',
  'Предсогласованная альтернатива': 'Pre-approved alternative',
  'Допник убирает только листья.': 'An amendment can only touch leaf stages.',

  // ── материалы и единицы ──
  'Кабель ВВГнг 3×2.5': 'Cable NYM 3×2.5',
  'Ламинат': 'Laminate',
  'Цемент/смесь': 'Cement / mix',
  'Краска': 'Paint',
  'Кухонный гарнитур (комплект)': 'Kitchen cabinet set',
  'Мойка врезная': 'Drop-in sink',
  'Прочее': 'Other',
  'шт': 'pcs',
  'м²': 'm²',
  'м': 'm',
  'кг': 'kg',
  'л': 'L',
  'рулон': 'roll',
  'комплект': 'set',
  'напр. 4 шт': 'e.g. 4 pcs',
  'напр. 12 м²': 'e.g. 12 m²',
  'напр. 6 м': 'e.g. 6 m',
  'напр. 25 кг': 'e.g. 25 kg',
  'напр. 10 л': 'e.g. 10 L',
  'напр. 5 рулонов': 'e.g. 5 rolls',
  'напр. 1 комплект': 'e.g. 1 set',

  // ── каталог: сферы, виды работ, типы договоров ──
  'Ремонт и строительство': 'Repair and construction',
  'Отделочные работы': 'Finishing work',
  'Сборка мебели': 'Furniture assembly',
  'Электромонтаж': 'Electrical work',
  'Сантехнические работы': 'Plumbing work',
  'Ремонтные работы': 'Repair work',
  'Быт': 'Home help',
  'Бытовая помощь': 'Home help',
  'Бытовая помощь между людьми': 'Home help between people',
  'Переезды': 'Moving',
  'Переводы': 'Translation',
  'Дизайн-проект': 'Design project',
  'Ремонт ванной': 'Bathroom renovation',
  'Ремонт квартиры «под ключ»': 'Full apartment renovation',
  'Сборка шкафа-купе': 'Wardrobe assembly',
  'Сборка кухни': 'Kitchen assembly',
  'Монтаж сантехники': 'Plumbing installation',
  'Услуга — исполнитель без бизнес-статуса': 'Service — contractor without business status',
  'Услуга — исполнитель СМЗ/ИП/юрлицо': 'Service — contractor with business status',
  'Продажа — продавец-физлицо (личное имущество)': 'Sale — private seller (personal property)',
  'Продажа — продавец СМЗ/ИП/юрлицо': 'Sale — seller with business status',
  'Аренда вещи': 'Renting an item',
  'Аренда жилья': 'Renting a home',
  'Займ между физлицами': 'Loan between individuals',
  'Разовая услуга между физлицами — напоминание о самозанятости, «плавный вход»':
    'One-off service between individuals — a reminder about self-employment, a soft start',
  '(исключён)': '(excluded)',

  // ── уведомления ──
  'Договор ждёт вашей подписи': 'A contract is waiting for your signature',
  'Договор подписан обеими сторонами': 'The contract is signed by both sides',
  'Новое предложение по условиям договора': 'New proposal on the contract terms',
  'Оплата этапа получена': 'Stage payment received',
  'Открыт спор по этапу': 'A dispute was opened on a stage',
  'Срок приёмки этапа истекает через 2 часа': 'The acceptance window closes in 2 hours',
  'Архив сделки собран и готов к выгрузке': 'The deal archive is ready to download',
  'Приглашение принято — контрагент присоединился к сделке':
    'Invitation accepted — the other side joined the deal',
  'Этап принят': 'Stage accepted',
  'Этап сдан на приёмку': 'Stage submitted for acceptance',
  'Этап принят автоматически по истечении срока приёмки':
    'Stage accepted automatically when the window closed',
  'Открыть договор': 'Open the contract',
  'Открыть платёж': 'Open the payment',
  'Открыть спор': 'Open the dispute',
  'Открыть архив': 'Open the archive',
  'Открыть протокол разногласий': 'Open the disagreement record',
  'Подписать договор': 'Sign the contract',
  'Принять этап': 'Accept the stage',

  // ── подписи хроники (`MOCK_TIMELINE_TITLES`): они же — системные строки чата ──
  'Черновик создан': 'Draft created',
  'Черновик изменён': 'Draft updated',
  'Черновик удалён': 'Draft deleted',
  'Заключено дополнительное соглашение': 'An amendment was concluded',
  'Исполнение начато': 'Work started',
  'Исполнение завершено': 'Work completed',
  'Начался гарантийный период': 'Warranty period started',
  'Договор закрыт': 'Contract closed',
  'Договор расторгнут': 'Contract terminated',
  'Договор расторгнут заказчиком': 'Contract terminated by the customer',
  'Договор расторгнут исполнителем': 'Contract terminated by the contractor',
  'Отправлен контрагенту на согласование': 'Sent to the other side for review',
  'Отозван инициатором': 'Withdrawn by the initiator',
  'Отклонён контрагентом': 'Rejected by the other side',
  'Возвращён на доработку': 'Sent back for revision',
  'Возвращён инициатором на доработку': 'Sent back for revision by the initiator',
  'Подписант отклонил подписание — возвращён на доработку': 'The signatory declined — sent back for revision',
  'Предложена правка': 'A revision was proposed',
  'Правка принята': 'Revision accepted',
  'Правка отклонена': 'Revision rejected',
  'Встречная правка': 'Counter-revision',
  'Приняты все правки': 'All revisions accepted',
  'Текст договора зафиксирован для подписания': 'The contract text was frozen for signing',
  'Направлен запрос на подпись': 'A signature request was sent',
  'Подписан одной стороной': 'Signed by one side',
  'Запрос на подпись переадресован': 'The signature request was forwarded',
  'Срок запроса на подпись истёк': 'The signature request expired',
  'Гарантийный срок истёк': 'The warranty period expired',
  'Окно оспаривания расторжения закрыто': 'The window to object to the termination closed',
  'Этап начат': 'Stage started',
  'Этап отклонён': 'Stage rejected',
  'Допсоглашение создано': 'Amendment drafted',
  'Допсоглашение отправлено на согласование': 'Amendment sent for review',
  'Версия зафиксирована': 'Version frozen',
  'Запрошена подпись стороны': 'A party signature was requested',
  'Сторона подписала': 'A party signed',
  'Заявка на подпись переадресована': 'The signature request was forwarded',
  'Срок заявки на подпись истёк': 'The signature request expired',
  'Возвращено на доработку': 'Sent back for revision',
  'Отклонено второй стороной': 'Rejected by the other side',
  'Отозвано инициатором': 'Withdrawn by the initiator',
  'Материал добавлен': 'Material added',
  'Материал изменён': 'Material updated',
  'Материал удалён': 'Material removed',
  'Открыт спор': 'A dispute was opened',
  'Спор разрешён': 'Dispute resolved',
  'Оплата подтверждена обеими сторонами': 'Payment confirmed by both sides',
  'Подана гарантийная претензия': 'A warranty claim was filed',
  'Гарантийная претензия отклонена': 'The warranty claim was declined',
  'Гарантийная претензия урегулирована': 'The warranty claim was settled',

  // ── хендлы витрины (только показываются; ключи реестров не меняются, а
  //    `reputationHandlers` заводит псевдонимы под новое написание) ──
  marat_otdelkin: 'mia_chen',
  akovalev: 'adam_cole',
  masters_otdelki: 'finish_masters',
};

/**
 * Русский витринный набор: переводить нечего, подменяются только имена —
 * владелец мок-аккаунта и «говорящие» фамилии сидов (Отделкин, Заказчикова,
 * Косяк), уместные в тестах, но не на витрине. Контрагенты `DEMO_EN_COUNTERPARTIES`
 * заведены английскими именами — здесь же их русские двойники.
 */
const DICT_RU: Record<string, string> = {
  'Годвин': 'Дмитрий Орлов',
  'Годвин (физлицо)': 'Дмитрий Орлов (физлицо)',
  'ИП Годвин': 'ИП Орлов',
  'ИП Годвин · «Тёплый ремонт»': 'ИП Орлов · «Тёплый ремонт»',
  'Марат Отделкин': 'Марат Ахметов',
  'Мария Заказчикова': 'Мария Смирнова',
  'Дмитрий Косяк': 'Денис Козлов',
  'Пётр Закрытый': 'Пётр Зайцев',
  'Николай Гром': 'Николай Громов',
  'Анна Свет': 'Анна Светлова',
  marat_otdelkin: 'marat_akhmetov',
  godwin: 'd_orlov',

  'Lucas Weber': 'Артём Половцев',
  'Sofia Rossi': 'Ирина Соколова',
  'Noah Grant': 'Николай Громов',
  'Ella Novak': 'Анна Новикова',
  'Adam Cole': 'Артём Ковалёв',
  'Maria Silva': 'Мария Смирнова',
  'Oliver Hart': 'Олег Тихонов',
  Portland: 'Москва',
  Salem: 'Казань',
  Eugene: 'Санкт-Петербург',
  Bend: 'Алматы',
};

/** Перевод одной строки фикстуры. Неизвестную русскую строку оставляем как есть
 * (и запоминаем в `demoEnMissing`) — молча ломать смысл хуже, чем показать её. */
export function demoText(value: string): string {
  if (demoLang() === 'ru') return DICT_RU[value] ?? value;
  const exact = DICT[value];
  if (exact !== undefined) return exact;
  for (const [re, to] of PHRASES) {
    if (re.test(value)) return value.replace(re, to);
  }
  if (CYRILLIC.test(value)) demoEnMissing.add(value);
  return value;
}

function translateField(key: string, value: string): string {
  if (demoLang() === 'ru') return demoText(value);
  if (MONEY_KEY.test(key) && MONEY_VALUE.test(value)) return scaleMoney(value);
  // Язык интерфейса/документа демо-набора — английский (иначе договор
  // рендерился бы по-русски внутри английского приложения).
  if ((key === 'locale' || key === 'language') && value === 'ru') return 'en';
  return demoText(value);
}

/**
 * Обходит уже собранный сид и подменяет строки НА МЕСТЕ (объекты/массивы/Map).
 * Ключи объектов не трогаются: по ним ищут (`checklistRecommendations`,
 * реестры профилей), перевод ключа сломал бы поиск.
 */
export function demoize<T>(node: T, seen: WeakSet<object> = new WeakSet()): T {
  if (node === null || typeof node !== 'object') return node;
  if (seen.has(node as object)) return node;
  seen.add(node as object);

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const v = node[i] as unknown;
      if (typeof v === 'string') node[i] = demoText(v);
      else demoize(v, seen);
    }
    return node;
  }
  if (node instanceof Map) {
    for (const [k, v] of node.entries()) {
      if (typeof v === 'string') node.set(k, demoText(v));
      else demoize(v, seen);
    }
    return node;
  }
  if (node instanceof Set || node instanceof Date) return node;

  const obj = node as unknown as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (typeof v === 'string') obj[key] = translateField(key, v);
    else if (v !== null && typeof v === 'object') demoize(v, seen);
  }
  return node;
}

/** Применяет демо-набор (EN или RU) к сиду только при включённом флаге. */
export function applyDemoEn<T>(node: T): T {
  return isDemoStore() ? demoize(node) : node;
}
