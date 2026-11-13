/**
 * Мок юр-документов платформы (docs/tasks/Задача_feat_l10n-launch-surfaces.md
 * §B) — зеркало `GET /v1/legal/<doc>`: там текст лежит в языковом пакете
 * (`legal.privacy`/`legal.tos`, наполняется `l10n/merge_legal.py` из
 * `docs/legal/<code>/`), здесь — короткие фикстуры.
 *
 * Фикстуры СОКРАЩЁННЫЕ, но покрывают всю разметку, которую умеет
 * `MarkdownDocument` (заголовки, шапка со переводами строк внутри абзаца,
 * таблица, список, ссылка, жирный, разделитель, инлайн-код) — так мок-режим и
 * компонентные тесты проверяют рендер, а не длину простыни. Реальные тексты
 * едут через пакеты и покрыты тестами бэкенда/скрипта слияния.
 *
 * Языки: `en` (канон), `ru` (перевод носителем), `es` (машинный — показывает
 * тихую пометку «авто-перевод»). Любой другой язык уходит в EN-фолбэк — ровно
 * как на бэкенде, включая честный `locale` в ответе.
 */
import type { LegalDocSlug, LegalDocument } from '@porukam/core';

interface LegalPack {
  privacy: string;
  terms: string;
  notice: string;
  quality: 'human' | 'machine';
}

const EN: LegalPack = {
  quality: 'human',
  notice:
    'This English text is the authoritative version of this document. Translations into other languages are provided for convenience only; where a translation differs from this text, this text prevails.',
  privacy: `# Privacy Policy

**Service:** Porukam — porukam.app
**Version:** 1.0 · Effective 17 August 2026

---

## 1. What we store

| Data | Why |
|---|---|
| Name, email, avatar | Your account and profile |
| Events of a deal | The shared timeline |

## 2. What we never store

- **Original evidence files.** The platform keeps only the hash and a thumbnail.
- **Raw phone numbers.** Sign-in is with Google only.

## 3. Google sign-in

The Service asks Google for the narrowest available Drive permission (\`drive.file\`) and uses it only for your own backup. See the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy).
`,
  terms: `# Terms of Service

**Service:** Porukam — porukam.app
**Version:** 1.0 · Effective 17 August 2026

---

## 1. What the Service is — and what it is not

We record facts: who signed, when, and how it ended. **The legal effect of these records depends on the laws of your country.**

## 2. Price

The core of the Service is free, with no limits on the number of agreements.
`,
};

const RU: LegalPack = {
  quality: 'human',
  notice:
    'Английская версия — основная. Русский текст переведён с неё для удобства; при расхождении преимущественную силу имеет английская версия.',
  privacy: `# Политика конфиденциальности

**Сервис:** «По рукам» — porukam.app
**Версия:** 1.0 · Действует с 17 августа 2026

---

## 1. Что мы храним

| Данные | Зачем |
|---|---|
| Имя, e-mail, аватар | Ваш аккаунт и профиль |
| События сделки | Общая хронология |

## 2. Чего мы не храним никогда

- **Оригиналы файлов-доказательств.** Платформа хранит только хеш и миниатюру.
- **Телефонные номера в открытом виде.** Вход только через Google.

## 3. Вход через Google

Сервис запрашивает самое узкое разрешение на Диск (\`drive.file\`) и использует его только для вашей резервной копии. См. [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy).
`,
  terms: `# Условия использования

**Сервис:** «По рукам» — porukam.app
**Версия:** 1.0 · Действует с 17 августа 2026

---

## 1. Что такое Сервис — и чем он не является

Мы фиксируем факты: кто подписал, когда и чем закончилось. **Юридическая сила этих записей зависит от законов вашей страны.**

## 2. Цена

Ядро Сервиса бесплатно, без ограничений на число договорённостей.
`,
};

const ES: LegalPack = {
  quality: 'machine',
  notice:
    'Esta traducción automática se ofrece solo por comodidad. La versión inglesa es la principal; en caso de discrepancia, prevalece el texto inglés.',
  privacy: `# Política de privacidad

**Servicio:** Porukam — porukam.app
**Versión:** 1.0 · En vigor desde el 17 de agosto de 2026

---

## 1. Qué almacenamos

| Datos | Para qué |
|---|---|
| Nombre, correo, avatar | Tu cuenta y tu perfil |
| Eventos del acuerdo | La cronología compartida |

## 2. Qué no almacenamos nunca

- **Los archivos originales de prueba.** La plataforma solo guarda la huella y una miniatura.
- **Números de teléfono en claro.** El acceso es solo con Google.

## 3. Acceso con Google

El servicio solicita el permiso de Drive más limitado (\`drive.file\`) y lo usa únicamente para tu propia copia de seguridad. Consulta la [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy).
`,
  terms: `# Condiciones del servicio

**Servicio:** Porukam — porukam.app
**Versión:** 1.0 · En vigor desde el 17 de agosto de 2026

---

## 1. Qué es el servicio y qué no es

Registramos hechos: quién firmó, cuándo y cómo terminó. **El efecto jurídico de estos registros depende de las leyes de tu país.**

## 2. Precio

El núcleo del servicio es gratuito, sin límite en el número de acuerdos.
`,
};

const PACKS: Record<string, LegalPack> = { en: EN, ru: RU, es: ES };

export const LEGAL_DOC_SLUGS: readonly LegalDocSlug[] = ['privacy', 'terms'];

/** `null` — такого документа не бывает (404 `not_found` на бэкенде). */
export function findLegalDocument(doc: string, requested: string): LegalDocument | null {
  if (!LEGAL_DOC_SLUGS.includes(doc as LegalDocSlug)) return null;
  const slug = doc as LegalDocSlug;

  // Та же фолбэк-цепочка, что `apps.l10n.selectors._fallback_chain`: язык → en.
  const pack = PACKS[requested] ?? PACKS.en;
  const locale = PACKS[requested] ? requested : 'en';
  if (!pack) return null;

  return {
    doc: slug,
    locale,
    requested_locale: requested,
    authoritative_locale: 'en',
    quality: pack.quality,
    notice: pack.notice,
    body: slug === 'terms' ? pack.terms : pack.privacy,
  };
}
