import type { ContractType, ContractTypeOption, HandleEntry, MaterialCatalogItem, Sphere, UnitOption, WorkType } from '@porukam/core';
import { applyDemoEn } from './demoEn';

/** Каталог типов договоров (§8.5). excluded скрыт в UI; при попытке — 403. */
export const contractTypes: ContractType[] = [
  { code: 'repair_works', name: 'Ремонтные работы', sphere: 'Ремонт', tax_note: null, excluded: false },
  { code: 'finishing', name: 'Отделочные работы', sphere: 'Ремонт', tax_note: null, excluded: false },
  { code: 'furniture_assembly', name: 'Сборка мебели', sphere: 'Сборка мебели', tax_note: null, excluded: false },
  { code: 'plumbing', name: 'Сантехнические работы', sphere: 'Сантехника', tax_note: null, excluded: false },
  { code: 'electrical', name: 'Электромонтаж', sphere: 'Электрика', tax_note: null, excluded: false },
  {
    code: 'household_help',
    name: 'Бытовая помощь между людьми',
    sphere: 'Быт',
    tax_note: 'Разовая услуга между физлицами — напоминание о самозанятости, «плавный вход»',
    excluded: false,
  },
  // excluded — не показывается в каталоге, при прямом обращении → 403 contract_type_excluded
  { code: 'weapons_trade', name: '(исключён)', sphere: '—', tax_note: null, excluded: true },
];

/** Типы клиентского дерева (ADR-094, GET /contract-types) — зеркало сида
 * `apps/catalog/migrations/0004` (7 видимых Р1-типов, скрытые/excluded не отдаются). */
export const clientTreeContractTypes: ContractTypeOption[] = [
  { code: 'services_individual', name: 'Услуга — исполнитель без бизнес-статуса', client_option: 'service' },
  { code: 'services_business', name: 'Услуга — исполнитель СМЗ/ИП/юрлицо', client_option: 'service' },
  { code: 'sale_personal', name: 'Продажа — продавец-физлицо (личное имущество)', client_option: 'sale' },
  { code: 'sale_business', name: 'Продажа — продавец СМЗ/ИП/юрлицо', client_option: 'sale' },
  { code: 'rent_items', name: 'Аренда вещи', client_option: 'rent' },
  { code: 'rent_home', name: 'Аренда жилья', client_option: 'rent' },
  { code: 'loan_individuals', name: 'Займ между физлицами', client_option: 'loan' },
];

/** Справочник хендлов для выбора контрагента. */
export const handleDirectory: HandleEntry[] = [
  { handle: '@masterremont', display_name: 'Мастер Ремонт', kind: 'business', verification_level: 'verified' },
  { handle: '@artem_floor', display_name: 'Артём Половцев', kind: 'person', verification_level: 'basic' },
  { handle: '@irina_s', display_name: 'Ирина Соколова', kind: 'person', verification_level: 'basic' },
  { handle: '@svetdom', display_name: 'ООО «СветДом»', kind: 'business', verification_level: 'verified' },
  { handle: '@grom_master', display_name: 'Николай Гром', kind: 'person', verification_level: 'phone' },
];

/** Рекомендации чек-листа по материалам/типам работ (мок, GET /checklist-recommendations).
 * Ключ — КОД вида работ (ADR-097: фронт шлёт `w.code`, как ждёт Django;
 * имена-ключи оставлены для наследия DEV-06 — материального пути `?material=`. */
export const checklistRecommendations: Record<string, string[]> = {
  finishing_tiling: ['Плитка уложена без пустот (простукивание)', 'Швы затёрты равномерно, зазор ≤ 2 мм'],
  finishing_laminate: ['Зазор у стен 8–10 мм соблюдён', 'Стыки без расхождений, замки защёлкнуты'],
  finishing_wallpaper: ['Полотна без пузырей и отслоений', 'Рисунок совмещён на стыках'],
  Плитка: ['Плитка уложена без пустот (простукивание)', 'Швы затёрты равномерно, зазор ≤ 2 мм'],
  Ламинат: ['Зазор у стен 8–10 мм соблюдён', 'Стыки без расхождений, замки защёлкнуты'],
  Обои: ['Полотна без пузырей и отслоений', 'Рисунок совмещён на стыках'],
  Прочее: ['Работа выполнена согласно описанию этапа'],
};

/**
 * Сферы (DEV-09 §3, SpherePicker) — популярные сверху, остальное по поиску/«все сферы».
 * Ремонт-каталог (§12 «вне скоупа: каталог сфер полный — сейчас ремонт + заглушки»).
 */
export const spheres: Sphere[] = [
  { code: 'repair', name: 'Ремонт и строительство', popular: true },
  { code: 'finishing', name: 'Отделочные работы', popular: true },
  { code: 'furniture', name: 'Сборка мебели', popular: true },
  { code: 'plumbing', name: 'Сантехника', popular: true },
  { code: 'electrical', name: 'Электрика', popular: true },
  { code: 'household', name: 'Быт', popular: true },
  { code: 'moving', name: 'Переезды' },
  { code: 'translation', name: 'Переводы' },
  { code: 'design', name: 'Дизайн-проект' },
  { code: 'cleaning', name: 'Уборка' },
];

export const workTypes: WorkType[] = [
  { code: 'repair_kitchen', name: 'Ремонт кухни', sphere_code: 'repair' },
  { code: 'repair_bathroom', name: 'Ремонт ванной', sphere_code: 'repair' },
  { code: 'repair_apartment', name: 'Ремонт квартиры «под ключ»', sphere_code: 'repair' },
  { code: 'finishing_tiling', name: 'Плитка', sphere_code: 'finishing' },
  { code: 'finishing_laminate', name: 'Ламинат', sphere_code: 'finishing' },
  { code: 'finishing_wallpaper', name: 'Обои', sphere_code: 'finishing' },
  { code: 'furniture_wardrobe', name: 'Сборка шкафа-купе', sphere_code: 'furniture' },
  { code: 'furniture_kitchen', name: 'Сборка кухни', sphere_code: 'furniture' },
  { code: 'plumbing_install', name: 'Монтаж сантехники', sphere_code: 'plumbing' },
  { code: 'electrical_wiring', name: 'Электромонтаж', sphere_code: 'electrical' },
  { code: 'household_help', name: 'Бытовая помощь', sphere_code: 'household' },
];

/** Каталог материалов (DEV-09 §4.3, MaterialsModal) — «прочее» всегда доступно для свободного ввода. */
export const materialCatalog: MaterialCatalogItem[] = [
  { ref: 'cat-tile', title: 'Плитка керамическая', default_unit: 'm2' },
  { ref: 'cat-laminate', title: 'Ламинат', default_unit: 'm2' },
  { ref: 'cat-wallpaper', title: 'Обои', default_unit: 'roll' },
  { ref: 'cat-cement', title: 'Цемент/смесь', default_unit: 'kg' },
  { ref: 'cat-paint', title: 'Краска', default_unit: 'l' },
  { ref: 'cat-kitchen-set', title: 'Кухонный гарнитур (комплект)', default_unit: 'pcs' },
  { ref: 'cat-sink', title: 'Мойка врезная', default_unit: 'pcs' },
  { ref: 'other', title: 'Прочее' },
];

/** Единицы измерения (DEV-09 §4.3, UnitPicker) — с примером-подсказкой. */
export const units: UnitOption[] = [
  { code: 'pcs', label: 'шт', hint: 'напр. 4 шт' },
  { code: 'm2', label: 'м²', hint: 'напр. 12 м²' },
  { code: 'm', label: 'м', hint: 'напр. 6 м' },
  { code: 'kg', label: 'кг', hint: 'напр. 25 кг' },
  { code: 'l', label: 'л', hint: 'напр. 10 л' },
  { code: 'roll', label: 'рулон', hint: 'напр. 5 рулонов' },
  { code: 'set', label: 'комплект', hint: 'напр. 1 комплект' },
];

/** Английский демо-набор витрины (`demoEn.ts`): справочники подменяются один раз
 * при загрузке модуля и ТОЛЬКО по флагу — ключи объектов не трогаются, поэтому
 * поиск по коду вида работ (`checklistRecommendations`) продолжает работать. */
applyDemoEn(contractTypes);
applyDemoEn(clientTreeContractTypes);
applyDemoEn(handleDirectory);
applyDemoEn(checklistRecommendations);
applyDemoEn(spheres);
applyDemoEn(workTypes);
applyDemoEn(materialCatalog);
applyDemoEn(units);
