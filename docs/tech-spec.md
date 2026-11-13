# Trust Platform: Техническая спецификация (включая API)

## Информация о документе

| Поле | Значение |
|---|---|
| **Проект** | Trust Platform (По рукам) |
| **Документ** | Техническая спецификация: архитектура, модель данных, API |
| **Версия** | 2.0.4 |
| **Дата** | 22.07.2026 (ревизии 2.0.1–2.0.4 — 23–27.07.2026) |
| **Основан на** | Концепция v9.0 · Доменная модель v9 · Журнал ADR (001–058) |
| **Стек (зафиксировано заказчиком)** | Python + Django + Django REST Framework |
| **Охват** | Полноценный продукт, локализованный для РФ, с юрисдикционной абстракцией для расширения на другие страны. Не MVP |
| **Статус** | На согласование |

> ⚠ **ФИНМОДЕЛЬ v2 (01.08.2026) — читать до использования этого документа.** Решением заказчика **комиссия за заключение договора (ADR-054) отменена полностью**; ядро бесплатно и безлимитно; монетизация — платная бизнес-подписка (~990 ₽/мес) следующей волной (ADR-060 ч. 4, док 09 v2, док 28). Устарели и НЕ являются основанием для кода: §5.2.6 в части `contract_fee`/`fee_schedule_tier`, шаг оплаты комиссии в транзакции подписания (§6.1), тарифная роль сегмента (§6.6 — сегментация сохраняет каталожную и налоговую роль), пример ответа `/sign` с fee (§8.4), fee-эндпоинты (§8.7), приложение `billing` (§4), пункты НФТ о маржинальной шкале. Также: TSA в Р1 — **серверные метки через интерфейс `TimestampProvider`** (с полем «источник метки»; RFC 3161 подключается после запуска подписки — Ю-21); целевой прод Р1 — лин-T1 (одна ВМ, compose, self-managed PostgreSQL + WAL-G). При работе читать вместе с `claude/28_v2-финмодель_заметки-для-бэкенда.md` (бэкенд) и `claude/29_…заметки-для-фронтенда.md` (фронтенд). Полная синхронизация спеки — при постановке Э4/Э5.

> **Правило приоритета.** При расхождении между этим документом и ADR-журналом первичен ADR-журнал. Спецификация — это проекция принятых решений на технику; она не принимает новых архитектурных решений, а фиксирует их реализацию. Места, где спецификация вынуждена доопределять поведение, помечены **[Т-решение]** (техническое решение уровня спецификации) — их можно менять без ревизии ADR.

### Что изменилось в 2.0 (относительно 1.0)

Спецификация переведена с концепции v7.2 на **концепцию v9.0** и ADR 001–058. Существенные изменения:

1. **Монетизация — деньгами, не единицами.** Кошелёк единиц (UnitWallet) и «плата за договор в единицах» **удалены** (ADR-054 rev2 отклонил units/wallet). Введена **комиссия за заключение договора деньгами** по убывающей маржинальной шкале (1% → 0.2%), разовая, невозвратная, взимается при подписании.
2. **Платежи — 0% комиссии платформы.** Прежняя «комиссия 1% с получателя» на платёжных операциях (ADR-055) **снята**: платформа не берёт комиссию с платежей; на получателе остаётся только тариф платёжного оператора (СБП-сплит).
3. **Два профиля и сегменты C2C (ADR-058).** Введены профиль физлица и бизнес-профиль, `ContractSegment` (FREE_C2C / PAID_BUSINESS / SPECIAL / EXCLUDED) и справочник типов договоров с закрытым белым списком бесплатного C2C.
4. **Юрканал уведомлений — личный кабинет + push (ADR-057).** Юридически значимый канал доставки — размещение в личном кабинете (in-app) плюс push; email/SMS опциональны как дублирующие. Отсчёт доменных дедлайнов — от факта размещения в ЛК.
5. **Модуль идентичности и социального графа.** Добавлены TrustID (скрытый идентификатор, задел под блокчейн), @username/Handle, граф доверия (Contact), поиск по контактам через необратимые хеши, объединения-витрины (AddressableGroup).

### Ревизия 2.0.1 (23.07.2026) — синхронизация источников

По итогам сверки четырёх документов (реестр расхождений Р-1…Р-7, док. «Организация разработки» §7):

- исправлена арифметика примера в §8.4 (комиссия за заключение для договора 120 000 ₽: 1 020 ₽ по маржинальной шкале, а не 900 ₽);
- в §14 добавлены пп. 15–16: [Т-решение] об упразднении `PLATFORM_SPLIT` как способа расчёта и фиксация исправления семантики `has_business_status` в доменной модели;
- доменная модель синхронизирована (Р-1…Р-5): семантика `has_business_status`, состав `PaymentMethod`/`PaymentStatus`, `Sphere`-справочник, переименование `AdditionalAgreement` → `Amendment`.

### Ревизия 2.0.2 (23.07.2026) — стадийность клиентов Р1

Принято решение заказчика о **двух стадиях выпуска клиентов** внутри Р1 (кандидат в ADR-журнал, см. §14 п. 17):

- **Р1-веб** — Web SPA, адаптивный + PWA (установка на экран телефона, web-push с ограничениями iOS). Доказательства этапа временно принимаются **загрузкой файлов через веб** с обязательной видимой пометкой «без усиленной доказательной защиты» (аналогия метки «без защиты платежа»);
- **Р1-мобайл** — нативное мобильное приложение, сфокусированное на доказательном контуре (встроенная камера + DeviceKey + офлайн-очередь, ADR-053) поверх уже работающего веб-функционала.

Скорректированы §12 и §13. Полный запрет галереи для evidence-роли и требование встроенной камеры вступают в силу с Р1-мобайл.

### Ревизия 2.0.3 (24.07.2026) — справочник валют

В `catalog` добавлен универсальный справочник `currency` (ISO 4217; данные, не код — §5.2.5), в `JurisdictionConfig` — `default_currency_code`. **Правило ADR-041 неизменно:** валюты по умолчанию в логике и хранении нет — каждая денежная величина несёт валюту явно; `default_currency_code` — только UI-подстановка при создании договора (принцип автозаполнения: подставляем, человек видит и подтверждает). Р1: активна только RUB, выбора валюты в UI нет; валюта договора валидируется против допустимых валют юрисдикции; один договор — одна валюта (концепция §46).

### Ревизия 2.0.4 (27.07.2026) — ADR-059 «Приватность, находимость и видимость профиля»

Появился рабочий ADR-059 (`claude/ADR-059_приватность_находимость_и_видимость.md`; финальная запись в журнал — после стабилизации). Ключевой разворот: **публичность по умолчанию** — профиль публичен и находим сразу после регистрации, приватность — осознанная настройка (opt-out). Проекция на спецификацию (затрагивает §5.2.1/5.2.1b social, §5.2.3 profiles, §8.1b, §8.11 marketplace; см. §14 п. 18):

- **[Обновлено финалом ADR-059, 01.08.2026 + 152-ФЗ-2025]** регистрация включает шаг «Данные и приватность» с **тремя отдельными согласиями** (обработка ПД / публичность профиля / находимость по телефону; ничего не предзаполнено, «да» лишь подсвечен как рекомендуемый); универсальная модель `Consent` (тип, значение, `text_version`, история строками без перезаписи, под envelope-ключом); `discoverable_by_phone` — **NULL до явного выбора, дефолтов в БД нет**; несматченные хеши телефонной книги удаляются в той же транзакции сверки; `@handle` и прямая ссылка/QR — всегда доступны; раскрытие контрагенту в контексте сделки — всегда;
- каталог/поиск (Путь В/Г): показываются **все** с заявленной проф. сферой, физлица наравне с бизнесом; сферы отмечаются при регистрации; тумблер «скрыть из каталога»;
- настройки видимости — на базовом `Profile` (уровень доступа к карточке, видимость полей: телефон скрыт, верификация и ключевые факты открыты, локация — город обобщённо);
- инертность непубличной карточки юрлица без claim (ADR-042) — не пересматривается.

**Перенумерация:** кандидат ADR для стадийности клиентов (§14 п. 17) — теперь **ADR-060** (номер 059 занят).

---

# СОДЕРЖАНИЕ

1. Введение: цели, границы, что отнесено на дальнейшие релизы
2. Архитектура системы
3. Технологический стек (рекомендация и обоснование)
4. Модульная декомпозиция (Django apps)
5. Модель данных (PostgreSQL)
6. Машины состояний и событийная модель
7. API: общие положения
8. API: ресурсы и операции (детально)
9. Интеграции и провайдеры юрисдикции (РФ)
10. Безопасность, персональные данные, аудит
11. Нефункциональные требования
12. Требования к мобильному клиенту
13. План релизов
14. Открытые вопросы для проработки в ходе разработки

---

# 1. ВВЕДЕНИЕ

## 1.1. Что строим

Trust Platform («По рукам») — инфраструктура доверия для сделок между людьми и бизнесом: юридически значимые договоры с чек-листами приёмки, защищённые расчёты без хранения средств на счетах платформы, доказательная база судебного качества и репутация как история выполненных обещаний. Платформа одинаково обслуживает бытовые сделки между соседями (C2C) и профессиональный подряд (B2C/B2B).

Настоящий документ описывает **техническую реализацию**: серверную архитектуру, модель данных, публичное API, интеграции и требования к клиентам. Бизнес-логика и обоснования решений — в концепции v9.0 и ADR-журнале; здесь они не повторяются, а адресуются ссылками вида (ADR-NNN) и (концепция §NN).

## 1.2. Аудитория

Команда разработки (backend, mobile, frontend), DevOps, QA, технический директор. Документ предполагает знакомство с концепцией v9 и доменной моделью v9.

## 1.3. Границы первого продукта (не MVP)

В первый продукт входит **вся базовая конфигурация** концепции v9:

- субъекты и полномочия: User (с TrustID и @username), два профиля (физлицо/бизнес), BusinessEntity, Representative, SigningAuthority, claim юрлица (ADR-042), эпохи владения;
- идентичность и социальный граф: TrustID (скрытый), Handle (@username), граф доверия (Contact), поиск по контактам через необратимые хеши (152-ФЗ), объединения-витрины (AddressableGroup) — только группировка, лидер подписывает от своего имени;
- сегментация договоров (ADR-058): `ContractSegment` и справочник типов договоров; закрытый белый список бесплатного C2C; возмездные услуги между физлицами без бизнес-статуса — бесплатны как «плавный вход в предпринимательство»;
- полный жизненный цикл договора: согласование с протоколом разногласий и предодобренными альтернативами, заморозка версии, адресное подписание, дерево этапов, материалы со справочником, допники;
- расчёты: **прямой платёж через платформу (целевой, ADR-056)**, предоплата, наличные, внешний безнал — с двусторонним подтверждением; **платежи с 0% комиссии платформы (ADR-055)**; **комиссия за заключение договора деньгами по маржинальной шкале (ADR-054 rev2)** для платных сегментов;
- приёмка, споры, инструменты диалога, потолок 30 дней, гарантия;
- доказательная база: встроенная камера, делегированная съёмка и офлайн-режим (ADR-053), RFC 3161, экспорт пакета;
- репутация по сферам с эпохами и Insights, портфолио, членства;
- субподряд через связи договоров (ADR-040), дашборды ролей (ADR-051);
- юрисдикционная абстракция: универсальное ядро + `JurisdictionConfig` c полным набором интерфейсов провайдеров; наполнение — только РФ;
- комплаенс РФ: ЕСИА-верификация (ADR-052), проверка НПД перед каждой выплатой (для платных сегментов), стоп-листы, лимит 2,4 млн, мониторинг систематичности (концепция §6.1–6.2);
- уведомления с юридической значимостью через личный кабинет + push (ADR-039, ADR-057), аудит-лог с цепочкой хешей (ADR-038), crypto-shredding (ADR-035).

## 1.4. Отнесено на дальнейшие релизы

Трудоёмкое и не критичное для запуска (архитектурные заделы при этом закладываются сразу — поля, интерфейсы, фича-флаги):

| Что | Куда | Основание |
|---|---|---|
| Эскроу-холд через провайдера (лестница защиты, ступень 2) | Релиз 2 | ADR-056: запуск без эскроу-контура, провайдер подключается вторым этапом |
| Автоматизация закрывающих документов через EDI-провайдера (в Р1 — генерация актов платформой + чеки НПД) | Релиз 2 | ADR-037, открытый вопрос №5 |
| ИИ-ассистент разбивки на этапы и чек-листов | Релиз 3+ | ADR-016, после накопления данных справочника |
| Особые сегменты (недвижимость/транспорт, аренда между физлицами) — отдельная проработка договорных модулей | Релиз 2 | ADR-058, П-15 (реестр открытых вопросов) |
| Перенос TrustID в публичный распределённый реестр (блокчейн-якорение) | По решению | Задел заложен: TrustID стабилен и не зависит от контактных данных |
| Премиум-функции, API-доступ партнёрам | Релиз 2–3 | ADR-027 |
| «Гарантированная сделка», лимит доверия | Не планируется до смены юрстатуса | Концепция §49, конфликт с ADR-021 |
| Мультивалютная логика (структура «сумма+валюта» — с первого дня) | При выходе во вторую страну | ADR-041 |
| Маркетплейс медиаторов (в Р1 — ручное подключение медиатора оператором) | Релиз 2 | ADR-018 |
| «Гарантированная сделка», механики с хранением средств | Запрещены к включению | ADR-021 |
| Биометрия через ЕБС | По необходимости | ADR-052 |
| Публичная витрина/SEO-каталог исполнителей (Путь В/Г — в Р1 внутренним поиском) | Релиз 2 | Концепция §12 |

## 1.5. Термины

Используются термины доменной модели без перевода: Contract, ContractSegment, Milestone (этап; лист/ветка), Amendment (допник), SigningAuthority, Representative, Claim, Evidence, Dispute, TrustID, Handle, AddressableGroup, JurisdictionConfig. Терминологическая красная линия концепции §12 (никакой лексики трудовых отношений) распространяется на нейминг API: `projects`, `orders`, `contractors` — допустимо; лексика трудовых отношений — запрещена в публичных контрактах API.

---

# 2. АРХИТЕКТУРА СИСТЕМЫ

## 2.1. Архитектурный стиль: модульный монолит + выделенные периферийные сервисы

**Решение [Т-решение]:** ядро — один Django-проект, разбитый на изолированные приложения (bounded contexts) со строгими правилами зависимостей; вокруг него — небольшое число выделенных сервисов там, где этого требуют изоляция или профиль нагрузки.

Почему не микросервисы с первого дня: доменная модель насыщена транзакционными инвариантами, пересекающими контексты (подписание = снепшот полномочий + заморозка версии + начисление и оплата комиссии за заключение + событие), и в монолите они решаются одной транзакцией PostgreSQL. Дробление на сервисы до стабилизации границ дало бы распределённые транзакции без выгоды. Модульность обеспечивается на уровне кода (см. 2.3), что позволяет выделить сервис позже без переписывания.

Выделено из монолита с первого дня:

| Сервис | Почему отдельно |
|---|---|
| **Audit Vault** — приём и хранение аудит-лога | ADR-038 требует append-only хранилище, **отдельное** от основной БД, с цепочкой хешей. Отдельный процесс с собственной БД и односторонним API (только запись + верификация цепочки) гарантирует, что компрометация основного приложения не даёт возможности редактировать лог |
| **Evidence Ingest** — приём доказательных файлов | Профиль нагрузки (большие multipart-загрузки с мобильных, проверка подписей DeviceKey, хеширование, RFC 3161) не должен конкурировать за воркеры с API. Реализуется как отдельный Django/ASGI-инстанс того же кодобейза (shared apps), горизонтально масштабируемый независимо |
| **Notification Dispatcher** | Размещение уведомления в личном кабинете + отправка push/email/SMS с эскалацией и фиксацией факта размещения и доставки (ADR-039, ADR-057) — воркеры Celery в отдельной очереди с собственным ретрай-профилем |

## 2.2. Компонентная схема

```
                        ┌──────────────┐   ┌───────────────┐
  Mobile (iOS/Android)  │              │   │ Evidence      │──► S3-совместимое
  Web SPA               │  API Gateway │──►│ Ingest (ASGI) │    хранилище (WORM)
  ────────────────────► │  (nginx)     │   └───────────────┘
                        │              │   ┌───────────────────────────┐
                        └──────┬───────┘   │ Целевой RPS-профиль:      │
                               │           │ API p95 < 300 мс          │
                        ┌──────▼───────┐   └───────────────────────────┘
                        │ Django Core  │──► PostgreSQL 16 (primary + replica)
                        │ (DRF, WSGI/  │──► Redis (кеш, rate-limit, блокировки)
                        │  ASGI)       │──► Audit Vault (append-only, gRPC/HTTP)
                        └──────┬───────┘
                               │ transactional outbox
                        ┌──────▼───────┐
                        │ Celery workers│──► очереди: payments / timers /
                        │ + beat        │    notifications / registry / media
                        └──────┬───────┘
                               │
        ┌──────────┬───────────┼──────────────┬──────────────┐
        ▼          ▼           ▼              ▼              ▼
     ЕСИА/     ЕГРЮЛ/ФНС    Платёжные      ФНС НПД       TSA (RFC 3161),
     Госключ   (Dadata/     партнёры ×2    (статус,      push/SMS/Email
     (через    Контур)      (СБП-сплит)    чеки)         провайдеры
     посредника)
```

## 2.3. Правила модульности внутри монолита

1. **Приложения общаются через сервисные фасады** (`apps/<name>/services.py`), а не через прямой импорт чужих моделей в бизнес-логику. Импорт чужих моделей разрешён только для FK-полей и read-only запросов в query-слое.
2. **Доменные события** — единственный способ реакции одного контекста на изменения другого (см. 6.4): подписание договора публикует `contract.signed`, на него подписаны биллинг (начисление комиссии за заключение — только для платных сегментов), репутация (нет — репутация только по завершении), уведомления, аудит.
3. **Запрещено:** сигналы Django для бизнес-логики (только явные вызовы и события через outbox); бизнес-логика в сериализаторах и вьюхах; изменяемые «толстые» модели-божества.
4. Проверка границ — `import-linter` в CI с контрактом слоёв.

## 2.4. Слои внутри приложения

```
api/          — DRF: сериализаторы, вьюсеты, роутинг, permissions (тонкие)
services.py   — прикладные операции (use cases): транзакции, инварианты, события
selectors.py  — read-слой: запросы для API и дашбордов
models.py     — модели, ограничения БД, «якорные» методы без побочных эффектов
events.py     — типы доменных событий контекста
providers/    — интерфейсы внешних провайдеров (если контекст их имеет)
tasks.py      — Celery-задачи (тонкие обёртки над services)
```

Паттерн — HackSoftware Django-Styleguide (services/selectors). Толстые transaction-script-сервисы предпочтительнее DDD-агрегатов в чистом виде: команда получает предсказуемый, легко ревьюируемый код.

## 2.5. Асинхронная обработка и таймеры

Celery + Redis (broker) + отдельные очереди по классам задач. Таймеры доменных дедлайнов (приёмка 48 ч, окна оспаривания, потолок спора 30 дней, окно выгрузки 72 ч, истечение хранения, сделка без движения 3 месяца — ADR-138) реализуются **не** отложенными задачами «выстрелить через 48 часов», а **строчками-дедлайнами в БД** (`deadline_at` + периодический sweep каждую минуту):

- отложенная задача теряется при сбое брокера — дедлайн в БД нет;
- ADR-039 требует паузы тайм-аутов при простое платформы: sweep-модель позволяет пересчитать дедлайны массово (`deadline_at += downtime`), с отложенными задачами это нереализуемо;
- отсчёт «от факта размещения уведомления в личном кабинете» (ADR-057) означает, что дедлайн становится известен постфактум — sweep читает актуальное значение.
- дедлайн «без движения» (`contract_idle`, ADR-138) переносится при каждом действии стороны обновлением той же строки (`reschedule_deadline`), а не новой строкой — sweep видит актуальный `deadline_at`; предупреждение за две недели — серия напоминаний по той же строке.

Периодические задачи (Celery beat): sweep дедлайнов (1 мин), фоновая сверка директоров с реестром (ADR-012, еженедельно с размазыванием), проверка статуса НПД перед выплатами (по событию + суточная сверка активных исполнителей платных сегментов), мониторинг аннулированных чеков НПД (ежедневно), пересчёт счётчиков систематичности (ежедневно), уведомления об истечении хранения доказательств (ежедневно).

## 2.6. Событийная шина

Внутри системы — **transactional outbox**: доменное событие пишется в таблицу `outbox_events` в той же транзакции, что и изменение данных; отдельный relay-воркер публикует события подписчикам (Celery-задачи) и в ленту событий объекта (§6.4). Внешняя шина (Kafka и т.п.) в Р1 не вводится — объёмы не требуют, а outbox гарантирует то же «ровно после коммита». Формат события фиксируется сразу (см. 6.4), чтобы миграция на внешнюю шину была заменой relay, а не переписыванием.

---

# 3. ТЕХНОЛОГИЧЕСКИЙ СТЕК

## 3.1. Состав (рекомендация)

| Слой | Выбор | Обоснование |
|---|---|---|
| Язык | **Python 3.12** | Зафиксировано заказчиком; доменная модель уже в Python-стиле |
| Веб-фреймворк | **Django 5.2 LTS** | LTS-поддержка до 2028; ORM с CHECK/EXCLUDE-ограничениями, миграции |
| API | **Django REST Framework 3.16** | Зафиксировано заказчиком |
| Схема API | **drf-spectacular** | OpenAPI 3.1 генерируется из кода — документация не расходится с реализацией; Swagger UI для команды |
| СУБД | **PostgreSQL 16** | JSONB для снепшотов, партиционирование лент событий, ltree/recursive CTE для дерева этапов, row-level security для Audit Vault |
| Кеш/блокировки/rate-limit | **Redis 7** (два инстанса: cache и broker) | Разделение профилей: вымывание кеша не должно трогать очереди |
| Очереди | **Celery 5** + beat | Стандарт экосистемы; отдельные очереди по классам задач |
| Объектное хранилище | **S3-совместимое** (Yandex Object Storage / VK Cloud + MinIO в dev), бакеты с Object Lock (WORM) для оригиналов доказательств | Соответствие ADR-036/038: оригинал недоступен для перезаписи даже админу |
| Машины состояний | **django-fsm-2 или собственный лёгкий FSM-механизм [Т-решение]** | Переходы задекларированы в одном месте, побочные эффекты только в services |
| Криптография | **pyca/cryptography** + KMS облака (или HashiCorp Vault Transit) | Envelope encryption для crypto-shredding (§10.2); необратимые хеши контактов и TrustID |
| Метки времени | **собственный RFC 3161-клиент** (`services/audit_vault/tsa.py`, `cryptography` + минимальный DER; без `rfc3161ng`) | ADR-036, ADR-135 |
| Документы (PDF договора, доказательный пакет) | **WeasyPrint** (HTML→PDF) + **reportlab** для штампов | Управляемые шаблоны, кириллица |
| Поиск (Путь В/Г) | **PostgreSQL FTS** в Р1; OpenSearch — при росте каталога | Не плодить инфраструктуру раньше нужды |
| Наблюдаемость | **Sentry + Prometheus/Grafana + structlog (JSON-логи) + OpenTelemetry** | НФТ §11; метрики аптайма нужны юридически (пауза тайм-аутов) |
| Контейнеризация | **Docker + Kubernetes** (или Docker Compose на старте, K8s при росте) | Раздельное масштабирование core / evidence ingest / workers |
| CI/CD | GitLab CI / GitHub Actions: линтеры (ruff, mypy strict на services/models), import-linter, pytest, миграционный гейт | |
| Инфраструктура | РФ-облако (Yandex Cloud / VK Cloud / Selectel) — требование 152-ФЗ о локализации ПД | Док. 05/06 проекта |

## 3.2. Чего сознательно нет в Р1

Kafka/RabbitMQ (outbox достаточно) · ClickHouse (аналитика — на реплике PostgreSQL) · GraphQL (один тип клиентов, REST достаточно) · отдельный микросервис платежей (изолирован приложением `payments` + идемпотентность) · Kubernetes-оператор БД (managed PostgreSQL облака) · внешний блокчейн для TrustID (задел заложен, включается позже).

---

# 4. МОДУЛЬНАЯ ДЕКОМПОЗИЦИЯ (DJANGO APPS)

| Приложение | Ответственность | Ключевые модели | Основные ADR |
|---|---|---|---|
| `accounts` | Пользователи, TrustID, аутентификация, сессии, устройства, DeviceKey | User, UserDevice, DeviceKey | 052, 053, 058 |
| `identity` | Верификация личности, провайдеры (ЕСИА), уровни | IdentityVerification | 052 |
| `social` | Хендлы (@username), граф доверия, поиск по контактам, объединения-витрины | Handle, Contact, PhonebookHash, AddressableGroup, GroupMembership | 058, соцграф-модуль концепции §II-A |
| `entities` | Юрлица, онбординг по ИНН, claim, эпохи владения | BusinessEntity, EntityClaim, OwnershipEpoch | 001, 042, 044, 012 |
| `authority` | Representative, SigningAuthority, назначения на договор | Representative, SigningAuthority, ContractAssignment | 003, 004, 053 |
| `profiles` | Профили (физлицо/бизнес), портфолио, членства | PersonProfile, BusinessProfile, Portfolio, PortfolioProject, Community, Membership | 002, 045, 046, 058 |
| `contracts` | Договор, сегмент, тип, версии, стороны, согласование, протокол разногласий, подписание, допники | Contract, ContractVersion, ContractParty, RevisionProposal, SignatureRequest, Signature, Amendment, AmendmentChange | 005–010, 048, 058 |
| `milestones` | Дерево этапов, чек-листы, материалы, приёмка | Milestone, ChecklistItem, ContractMaterial, AcceptanceWindow | 008, 016, 017, 047 |
| `catalog` | Справочники: сферы, типы договоров (сегменты), номенклатура материалов, шаблоны чек-листов, валюты | Sphere, ContractTypeCatalogItem, MaterialCatalogItem, ChecklistTemplateItem, Currency | 041, 043, 047, 058 |
| `payments` | Платёжные операции, прямой платёж (0% комиссии платформы), подтверждения, провайдеры | Payment, PaymentIntent, PayoutAccount, ProviderRoute | 021–026, 055, 056 |
| `billing` | Комиссия за заключение договора деньгами, тарифная шкала, счёт-начисление | ContractFee, FeeScheduleTier | 054 |
| `disputes` | Споры, окна оспаривания, инструменты диалога, медиация | Dispute, DisputeWindow, FixRequest, DiscountAgreement, ExtensionRequest, MediationSession | 017–020 |
| `warranty` | Гарантийные периоды и заявки | WarrantyClaim | 029–031 |
| `evidence` | Доказательства, офлайн-пакеты, экспорт, хранение | EvidenceItem, EvidenceBatch, EvidencePackage, RetentionTimer | 036, 053 |
| `archive` | Доказательный пакет сделки (экспорт), выдача архива обеим сторонам, долгоживущие ссылки `/a/<token>` — read-композиция поверх contracts/milestones/payments/disputes/evidence + Audit Vault | ArchiveExport, ArchiveLink | 036, 137, 139 |
| `documents` | Договорные PDF, закрывающие документы, провайдеры | Document | 037 |
| `reputation` | Метрики по сферам, Insights, обжалования | SphereReputation, ReputationEvent, ReputationAppeal | 011–015, 030 |
| `links` | Связи договоров (субподряд), маппинг этапов | ContractLink, MilestoneMapping | 040 |
| `dashboards` | Селекторы дашбордов ролей (без собственных таблиц) | — | 051 |
| `marketplace` | Заявки заказчиков, отклики, каталог (Пути Б/В/Г) | ProjectRequest, RequestResponse | Концепция §12 |
| `notifications` | Уведомления: размещение в ЛК (юрканал) + push/email/SMS, доставка, эскалация | Notification, DeliveryAttempt | 039, 057 |
| `deadlines` | Единый реестр доменных дедлайнов + sweep | DomainDeadline | 039, 057, §2.5 |
| `jurisdictions` | JurisdictionConfig, LocalEntityForm, LocalTaxRegime, провайдерский реестр | JurisdictionConfig, LocalEntityForm, LocalTaxRegime | 032, 043 |
| `compliance` | Счётчики систематичности, НПД-контроль, стоп-листы, лимиты, счётчик-напоминание о регистрации СМЗ | ActivityCounter, NpdStatusCheck, AffiliationStopList, PairSystematicityCounter, SelfEmploymentPrompt | 034, 049, 058, концепция §6.2 |
| `audit` | Клиент Audit Vault, лента событий объекта, outbox | OutboxEvent, ObjectTimelineEntry (read-модель) | 038, концепция §37a |
| `backoffice` | Внутренние роли и админ-операции | PlatformOperator | 038 |
| `messaging` | Переписка по договору (append-only, доказательная база к спору) | Message | ADR-112 |

Правило зависимостей (import-linter): `catalog`, `jurisdictions` — нижний слой (ни от кого не зависят); `social` зависит только от `accounts`; `contracts` не импортирует `payments`/`disputes`/`messaging` (те подписаны на его события); `dashboards` — только selectors поверх остальных.

---

# 5. МОДЕЛЬ ДАННЫХ (POSTGRESQL)

## 5.1. Конвенции

- **PK** — `uuid` (v7 [Т-решение]: сортируемость по времени улучшает локальность индексов), генерируется приложением.
- Все таблицы: `created_at`, `updated_at` (timestamptz). Бизнес-время — только timestamptz UTC; отображение по TZ пользователя.
- **Деньги** — пара колонок `*_amount numeric(14,2)` + `*_currency char(3)` (ISO 4217). Валюты по умолчанию нет нигде (ADR-041). Составной тип/домен `money_value` — допустимая альтернатива.
- **Enum'ы** — `text` + CHECK-ограничение (не PostgreSQL ENUM: миграции значений дешевле). Значения — snake_case из доменной модели.
- **Мягкого удаления нет** для юридически значимых сущностей: договоры, версии, подписи, доказательства, платежи не удаляются никогда; ПД удаляются crypto-shredding'ом (§10.2).
- Ограничения целостности — **в БД**, а не только в коде: CHECK-и, уникальности, exclusion constraints. Ниже перечислены обязательные.

## 5.2. Ключевые таблицы и ограничения

Ниже — не полный DDL, а несущие конструкции: состав полей соответствует доменной модели, здесь фиксируются типы, ограничения и индексы, которые гарантируют инварианты.

### 5.2.1. accounts / identity

```
user(id, trust_id text UNIQUE NOT NULL,     -- стабильный внутренний идентификатор
     phone citext UNIQUE, email citext UNIQUE, full_name_encrypted bytea,
     verification_level text CHECK (in guest|basic|verified|business),
     personal_tax_id_hash text,            -- хеш ИНН для сверок без раскрытия
     has_business_status bool DEFAULT false, -- СМЗ/ИП: влияет на сегмент договора (ADR-058);
                                             -- ТОЛЬКО собственный статус, представительство
                                             -- чужого юрлица статуса НЕ даёт (см. §14 п.16)
     encryption_key_ref text, is_active bool, is_banned bool)
     -- trust_id: непубличный, неизменяемый, не зависит от телефона/почты;
     -- задел под якорение во внешнем распределённом реестре (блокчейн)

identity_verification(id, user_id FK, provider text, level text,
     verified_full_name_encrypted bytea, verified_attributes jsonb,
     verified_at, expires_at, status text)
     -- ядро не знает слов «ЕСИА»: provider — код из JurisdictionConfig (ADR-052)

user_device(id, user_id FK, platform text, push_token text, last_seen_at)
device_key(id, user_id FK, device_id FK, public_key bytea, algorithm text,
     issued_at, revoked_at NULL)           -- ADR-053; приватный ключ сервер не видит
```

### 5.2.1b. social (идентичность и граф доверия)

```
handle(id, user_id FK NULL, group_id FK addressable_group NULL, value citext UNIQUE,
     is_active bool, changed_at NULL,
     CHECK ((user_id IS NULL) <> (group_id IS NULL)))
     -- @username: адресуемость, НЕ верифицированная личность; может менять владельца
     -- истории; при передаче — прежние ссылки инвалидируются

contact(id, owner_user FK, target_user FK NULL, target_phone_hash text NULL,
     display_name_encrypted bytea, source text CHECK (in phonebook|manual|deal|link),
     is_mutual bool DEFAULT false, created_at,
     UNIQUE (owner_user, target_user), UNIQUE (owner_user, target_phone_hash))
     -- граф доверия; ребро приватно, видит только owner; target_user проставляется
     -- когда контакт находится по хешу телефона

phonebook_hash(id, user_id FK, phone_hash text, algorithm text, salt_ref text,
     uploaded_at, UNIQUE (user_id, phone_hash))
     -- необратимые хеши номеров из телефонной книги (152-ФЗ): сырые номера
     -- не хранятся; сопоставление «кто есть на платформе» идёт по хешам

addressable_group(id, kind text CHECK (in company_storefront|community|informal),
     leader_user FK NOT NULL, name, description, is_public bool,
     reputation_mode text CHECK (in aggregate_only|none))
     -- объединение-витрина: ТОЛЬКО группировка и адресация; договоры от имени группы
     -- не заключаются — подписывает лидер (или уполномоченное физлицо/юрлицо) от себя

group_membership(id, group_id FK, member_user FK, role text CHECK (in leader|admin|member),
     status text CHECK (in invited|active|left), joined_at,
     UNIQUE (group_id, member_user))
```

**Границы модуля (ADR-058, концепция §II-A):** Handle не даёт юридической идентификации — подписантом всегда выступает верифицированное физлицо или юрлицо; AddressableGroup не является стороной договора; поиск по контактам работает только по совпадению необратимых хешей и не раскрывает номера.

### 5.2.2. entities / authority

```
business_entity(id, country_of_registration char(2), local_form_code text,
     tax_regime_code text, name, short_name,
     registered_address jsonb, bank_details_encrypted bytea,
     verification_status text, verified_against_registry bool, verified_at,
     claim_status text CHECK (in unclaimed|pending|claimed|disputed),
     claimed_by FK user NULL, claim_method text NULL, claimed_at NULL,
     director_full_name text, director_since date, director_source text,
     director_user FK user NULL, created_by FK user, encryption_key_ref text)

tax_identifier(id, entity_id FK, id_type text, value text,
     UNIQUE (id_type, value))              -- один ИНН — одна карточка

representative(id, user_id FK, entity_id FK, role text, permissions text[],
     is_active bool, approved_by FK,
     UNIQUE (user_id, entity_id))

signing_authority(id, user_id FK, entity_id FK, basis text,
     max_amount numeric NULL, max_amount_currency char(3) NULL,
     poa_registry_id text NULL, parent_authority FK NULL,
     last_verified_at, expires_at NULL, is_active bool)

ownership_epoch(id, entity_id FK, epoch_number int, director_identity_hash text,
     started_at, ended_at NULL, detected_via text,
     reputation_snapshot jsonb NULL, contracts_count int,
     EXCLUDE USING gist (entity_id WITH =, tstzrange(started_at, ended_at) WITH &&))
     -- эпохи одного юрлица не пересекаются во времени

contract_assignment(id, representative_id FK, contract_id FK,
     milestone_ids uuid[] NULL,            -- NULL = весь договор
     granted_by FK, valid_from, valid_until, revoked_at NULL)   -- ADR-053
```

**Инертность карточки** (ADR-042) реализуется не флагом в БД, а гейтом `assert_entity_operable()` в сервис-слое всех операций из списка ADR-042; список закрыт и покрыт тестами.

### 5.2.3. profiles

```
profile(id, kind text CHECK (in person|business),
     owner_user FK NULL, owner_entity FK NULL,
     CHECK ((owner_user IS NULL) <> (owner_entity IS NULL)),   -- ровно один владелец
     UNIQUE (kind, owner_user), UNIQUE (kind, owner_entity),
     ... поля профиля по доменной модели ...)
     -- kind=person — профиль физлица; kind=business — бизнес-профиль (СМЗ/ИП/юрлицо)
     -- заказчиком/исполнителем может быть любой профиль; сегмент договора считается
     -- по бизнес-статусу исполнителя и типу договора (ADR-058, §6.6)
```

Portfolio, PortfolioProject, Community, Membership — по доменной модели; `portfolio_project.verified_facts jsonb` заполняется только системой (нет API записи).

### 5.2.4. contracts

```
contract(id, deal_type text CHECK (in b2b|b2c|c2c),
     contract_type_code text NOT NULL REFERENCES contract_type_catalog_item(code),
     segment text CHECK (in free_c2c|paid_business|special|excluded),  -- ADR-058
     negotiation_status text, execution_status text NULL,
     payment_method text CHECK (in direct_platform|hold|prepayment|cash|external),
     protected bool, uses_platform_template bool,
     frozen_version FK contract_version NULL,
     customer_contact FK representative NULL, contractor_contact FK NULL,
     jurisdiction char(2), title text, sphere_id FK NULL,
     signed_at NULL, completed_at NULL, warranty_until NULL,
     encryption_key_ref text)
     -- segment вычисляется compute_segment() при создании и переоценивается при смене
     -- сторон/типа до заморозки (§6.6); excluded — договоры, которые платформа не готовит
     -- (реализация долей/паёв/ценных бумаг): создать нельзя, тип скрыт из выдачи
     -- payment_method: PLATFORM_SPLIT упразднён — сплит это рельс, не способ (§14 п.15)

contract_party(id, contract_id FK, role text CHECK (in customer|contractor),
     profile_id FK, entity_id FK NULL, acting_as text CHECK (in person|business),
     UNIQUE (contract_id, role))           -- ровно один customer и один contractor
     -- acting_as фиксирует, в каком качестве сторона входит в сделку (влияет на сегмент)

contract_version(id, contract_id FK, snapshot jsonb, integrity_hash text,
     hash_algorithm text, frozen_at, trusted_timestamp bytea NULL,
     UNIQUE (contract_id, integrity_hash))
     -- snapshot: полный слепок (текст, этапы, чек-листы, материалы, реквизиты
     -- сторон, основания подписи, признак бланка, deal_type, contract_type_code,
     -- segment, раскладка комиссии за заключение) — ADR-005/006/058

revision_proposal(id, contract_id FK, amendment_id FK NULL, item_ref text,
     old_value jsonb, new_value jsonb, comment, proposed_by FK profile,
     status text CHECK (in open|accepted|rejected|superseded), decided_by, decided_at,
     preapproved_alternative_of FK revision_proposal NULL)

preapproved_alternative(id, contract_id FK, item_ref text, payload jsonb,
     created_by)                            -- Bonterms-паттерн, §13.2

signature_request(id, contract_id FK, amendment_id FK NULL, version_id FK,
     side text, routed_by FK, signatory FK user, signing_authority FK,
     status text CHECK (in pending|signed|forwarded|declined_for_revision|expired),
     sent_at, responded_at, expires_at, comment,
     summary_shown_at timestamptz NULL)     -- факт показа AI-резюме, §14.3

signature(id, contract_id FK, amendment_id FK NULL, version_hash text, side text,
     signatory FK user, signed_at, signature_basis text,
     entity_snapshot jsonb, contact_snapshot jsonb,
     external_signature_ref text NULL)      -- ссылка на УНЭП/УКЭП Госключа
     UNIQUE (contract_id, amendment_id, side, version_hash)

amendment(id, contract_id FK, "order" int, reason text, custom_terms text,
     negotiation_status text, frozen_version FK NULL,
     UNIQUE (contract_id, "order"))

amendment_change(id, amendment_id FK, type text, target uuid NULL, payload jsonb,
     amount_delta numeric, amount_delta_currency char(3), days_delta int)
```

### 5.2.5. milestones / catalog

```
milestone(id, contract_id FK, parent_id FK milestone NULL, "order" int,
     title, status text, created_by_amendment FK NULL,
     amount numeric NULL, amount_currency char(3) NULL,
     sphere_id FK NULL, deadline timestamptz NULL, depends_on FK NULL,
     frozen_days int DEFAULT 0, submitted_at NULL, accepted_at NULL)
```

Инварианты дерева (лист/ветка) не выражаются декларативно в PostgreSQL, поэтому:
- триггер `milestone_amount_guard`: запрещает `amount IS NOT NULL` у узла с детьми и вставку ребёнка под узел, у которого есть платежи/приёмка;
- валидация суммы договора (`сумма листьев = сумма договора`) — при заморозке версии, в сервис-слое;
- запросы по дереву — recursive CTE; глубина ограничена **[Т-решение]** 6 уровнями (валидация), чтобы UI и запросы имели предсказуемую стоимость.

```
contract_type_catalog_item(id, code UNIQUE, name_i18n jsonb,
     default_segment text CHECK (in free_c2c|paid_business|special|excluded),
     requires_service_flag bool,           -- «возмездная услуга» — влияет на правило §6.6
     allowed_deal_types text[],            -- [c2c], [b2c,b2b] и т.п.
     is_hidden bool DEFAULT false,         -- excluded-типы скрыты из выдачи и создания
     needs_special_handling bool DEFAULT false,  -- недвижимость/транспорт, аренда
     legal_basis text, sort_order int, is_active bool)
     -- закрытый белый список типов договоров (ADR-058); данные, не код.
     -- Бесплатный C2C — набор кодов с default_segment=free_c2c (займы физлиц,
     -- купля-продажа личного имущества, урожай ЛПХ и т.д.).
```

```
checklist_item(id, milestone_id FK, description, measurable_criterion,
     required_evidence text[], source_template FK NULL, "order" int)

contract_material(id, milestone_id FK, catalog_item FK NOT NULL, description NOT NULL,
     external_url, quantity numeric, unit text, unit_price numeric,
     unit_price_currency char(3), source text CHECK (in contractor|customer),
     delivery_days int, delivery_base text, received bool, received_at,
     CHECK (source = 'customer' OR unit_price > 0))   -- правило цены ADR-047

material_catalog_item(id, code UNIQUE, sphere_id FK, name_i18n jsonb,
     suggested_unit, spec_template jsonb, is_active bool)
checklist_template_item(id, catalog_item FK NULL, sphere_id FK NULL,
     description, measurable_criterion, required_evidence text[])
sphere(id, code UNIQUE, name_i18n jsonb, is_active bool)   -- справочник, не enum

currency(code char(3) PK, numeric_code char(3), name_i18n jsonb, symbol text,
     decimal_places smallint DEFAULT 2, is_active bool)
     -- справочник ISO 4217, универсальный (ревизия 2.0.3). Р1: активна только RUB.
     -- ВАЖНО (ADR-041): справочник НЕ создаёт «валюту по умолчанию» в логике —
     -- каждая Money несёт валюту явно; jurisdiction_config.default_currency_code —
     -- только подстановка в UI при создании договора.
```

### 5.2.6. payments / billing

```
payment(id, contract_id FK, milestone_id FK, kind text
        CHECK (in advance|postpayment|prepayment|refund),
     method text, amount numeric, currency char(3),
     status text CHECK (in pending|processing|held|confirmed|captured|voided|refunded|disputed|failed|observed),
     confirmed_by_payer bool, confirmed_by_payee bool,
     provider text, provider_operation_id text, hold_expires_at NULL,
     operator_fee_amount numeric NULL, operator_fee_currency char(3) NULL,
     platform_commission_amount numeric DEFAULT 0,   -- ADR-055: платформа 0%
     payer_breakdown jsonb, payee_breakdown jsonb,   -- раскладка «до подтверждения»
     idempotency_key text, UNIQUE (provider, provider_operation_id),
     UNIQUE (idempotency_key))
     -- platform_commission_amount всегда 0: платформа не берёт комиссию с платежей.
     -- На получателе — только тариф платёжного оператора (operator_fee_*), СБП-сплит.
     -- status=observed — «прямой платёж наблюдён платформой» (целевой способ, ADR-056).

payout_account(id, profile_id FK, provider text, details_encrypted bytea,
     verified bool, is_default bool)

contract_fee(id, contract_id FK UNIQUE, amendment_id FK NULL,
     base_amount numeric, base_currency char(3),          -- сумма договора/дельта
     fee_amount numeric, fee_currency char(3),            -- рассчитанная комиссия
     effective_rate numeric,                              -- итоговая ставка, справочно
     status text CHECK (in pending|charged|failed|refunded_void),
     charged_at NULL, provider_operation_id text NULL,
     idempotency_key text UNIQUE)
     -- комиссия ЗА ЗАКЛЮЧЕНИЕ договора, деньгами (ADR-054 rev2): разовая, невозвратная,
     -- взимается при подписании для платных сегментов (paid_business, special);
     -- для free_c2c и excluded не создаётся. Возврат — только при откате подписания.

fee_schedule_tier(id, jurisdiction char(2), currency char(3),
     lower_bound numeric, upper_bound numeric NULL, marginal_rate numeric,
     valid_from, valid_until NULL)
     -- убывающая МАРЖИНАЛЬНАЯ шкала (ADR-054 rev2): 1% на первый диапазон … 0.2%
     -- на верхние; комиссия = Σ по диапазонам, как прогрессивный налог наоборот.
     -- Данные, не код.
```

Начисление и оплата комиссии за заключение — **в одной транзакции** с переходом договора в `signed` (для платных сегментов). Комиссия считается по маржинальной шкале от суммы договора; для допника с положительной дельтой доначисляется разница по шкале. Провал платежа комиссии не даёт договору вступить в силу (`409 contract_fee_charge_failed`). Для `free_c2c`/`excluded` шаг пропускается. Способ оплаты комиссии — тот же прямой платёж (провайдер), плательщик — по правилу сегмента (по умолчанию исполнитель платного сегмента).

### 5.2.7. disputes / warranty

```
dispute(id, milestone_id FK, checklist_item_id FK NOT NULL,  -- ADR-017
     opened_by FK profile, evidence uuid[], opened_at, cap_deadline_at,
     outcome text NULL CHECK (in resolved|cap_reached|escalated_to_court),
     fix_rounds_used int CHECK (fix_rounds_used <= 2))
dispute_window(id, kind text, subject_ref jsonb, opened_at, deadline_at,
     contested bool NULL)                        -- окна оспаривания ADR-019
fix_request / discount_agreement / extension_request / material_request /
mediation_session — по доменной модели; discount_agreement подписывается
через общий контур amendment (скидка = допник с MODIFY_MILESTONE).
warranty_claim(id, contract_id FK, description, evidence uuid[], status,
     resolution_type NULL)
```

### 5.2.8. evidence

Фактическая схема (ADR-136, миграция `evidence/0003`; сроки — ADR-137):

```
evidence(id, contract_id FK, milestone_id FK NULL, checklist_item_id FK NULL,
     dispute_id FK NULL,                         -- этап ИЛИ спор (CHECK)
     assignment_id FK contract_assignment NULL,  -- PROTECT
     uploaded_by FK user, device_key_id FK device_key NULL,   -- PROTECT
     file_name, mime_type, file_size,
     file_hash text NOT NULL,                    -- sha256 ОЧИЩЕННЫХ открытых байт
     trusted_timestamp_at, trusted_timestamp_source,          -- TimestampProvider
     thumbnail bytea NULL, metadata jsonb,       -- exif_meta спеки; manifest_sha256, duplicate_hash
     storage_mode CHECK (in server|ru|global),   -- server: бакет, шифротекст (все контуры, ADR-136 §9)
     s3_object_key text, encryption_key_ref text,-- объект в WORM-бакете + SubjectKey конверта
     transit_payload bytea NULL,                 -- только global (путь ГВ.3, до ADR-136)
     captured_at_device timestamptz NULL, device_clock_skew_ms bigint NULL,
     geo_encrypted bytea NULL, geo_key_ref text, -- гео = ПД (ADR-045): только шифротекст
     device_signature bytea NULL,                -- подпись DeviceKey (ADR-053)
     tsa_token bytea NULL,                       -- ADR-135: штамп на корень чекпойнта, поле под привязку
     lateness CHECK (in unknown|on_time|late|after_acceptance),   -- ADR-053 + «неизвестно»
     is_evidence_role bool,
     retention_state CHECK (in hot|archived|shredded), archived_at NULL, shredded_at NULL,
     delivery_status, delivered_to_counterparty_at NULL, backup_* ...)
     INDEX (file_hash)                           -- дедуп/анти-фрод: событие evidence.duplicate_hash
     CHECK (retention_state <> 'shredded' OR (s3_object_key = '' AND transit_payload IS NULL))

evidence_retention_timer(id, contract_id FK UNIQUE, anchored_at, state CHECK (in hot|archived|shredded),
     hot_deadline_id, archive_deadline_id, notice_deadline_id,   -- domain_deadline по значению
     paused_at NULL, pause_reason, paused_total interval, archived_at NULL, shredded_at NULL)
```

Архив сделки (ADR-139, `apps.archive`):

```
archive_export(id, contract_id FK, requested_by FK user NULL, trigger CHECK (in manual|auto),
     status CHECK (in queued|running|ready|failed), include_originals bool, manifest_only bool,
     is_snapshot bool, snapshot_at,                  -- единственное время в пакете (детерминизм)
     package_key, package_size, package_sha256, package_key_ref,   -- шифротекст конверта, бессрочно
     files_state CHECK (in not_requested|pending|available|shredded),
     files_key, files_size, files_sha256, files_key_ref, files_shredded_at NULL, files_expires_at NULL,
     manifest jsonb, sha256sums text, evidence_count,  -- дубль в БД: ссылка живёт дольше данных
     error, created_at, started_at NULL, finished_at NULL, delivered_at NULL)
     CHECK (status <> 'ready' OR package_key <> '')
     CHECK (files_state <> 'shredded' OR (files_key = '' AND files_shredded_at IS NOT NULL))

archive_link(id, export_id FK, kind CHECK (in package|files), party_role CHECK (in customer|contractor),
     recipient_id FK user NULL, token_hash text UNIQUE,   -- sha256 токена (256 бит)
     token_encrypted bytea NULL, token_key_ref text,      -- показать URL владельцу; отзыв = ключ уничтожен
     created_at, revoked_at NULL, last_access_at NULL, access_count int)
```

Хеши бессрочны: строка `evidence` не удаляется никогда; при истечении хранения (ADR-137: 3 мес горячее → до 1 года архив, пауза на спор с пределом 6 мес) уничтожается ключ конверта (`retention_state=shredded`), обнуляются `s3_object_key`/`transit_payload`; `file_hash`, `tsa_token`, миниатюра и метаданные остаются — включая удаление по запросу пользователя. Длительности — `DeadlineKindConfig` (`evidence_hot_retention`, `evidence_archive_retention`, `evidence_retention_notice`, `evidence_dispute_pause_cap`, `evidence_upload_window`), публично — `GET /evidence/retention-policy`.

### 5.2.9. compliance

```
npd_status_check(id, entity_id FK, checked_at, is_active_npd bool,
     annual_income_known numeric NULL, source text)
npd_receipt(id, payment_id FK, receipt_ref text, issued_at,
     annulled_at NULL, annulment_detected_at NULL)
affiliation_stop_list(id, customer_entity FK, inn_hash text, valid_until date,
     UNIQUE (customer_entity, inn_hash))         -- стоп-лист, хранится хешами
contractor_declaration(id, contract_id FK, declared_no_employment bool,
     declared_at)                                -- декларация исполнителя §6.2
activity_counter(user_id FK, window_days int, deals_in_window int, threshold int)
pair_systematicity(customer_profile FK, contractor_profile FK,
     deals_in_window int, income_share numeric NULL, months_active int)
self_employment_prompt(id, user_id FK, paid_deals_as_person int,
     threshold int, last_prompted_at NULL, dismissed_at NULL)
     -- ADR-058: счётчик платных C2C-услуг физлица без бизнес-статуса + напоминание
     -- оформить самозанятость («плавный вход в предпринимательство»)
```

### 5.2.10. audit / events / notifications / deadlines

```
outbox_event(id bigserial, event_id uuid, topic text, payload jsonb,
     occurred_at, published_at NULL)             -- партиционирование по месяцу

object_timeline(id, object_type text, object_id uuid, event_id uuid,
     visible_to jsonb, title_i18n jsonb, payload jsonb, occurred_at)
     -- read-модель ленты (§37a концепции); партиционирование по месяцу

notification(id, recipient FK user, template text, payload jsonb,
     legal_significance bool,
     placed_in_cabinet_at timestamptz NULL,      -- ADR-057: факт размещения в ЛК = юрканал
     read_at timestamptz NULL,
     push_sent_at NULL, email_sent_at NULL, sms_sent_at NULL,
     delivered_at NULL, delivered_via NULL,
     related_deadline FK NULL)
     -- юридически значимый факт доставки = placed_in_cabinet_at (in-app) + push;
     -- email/SMS — дублирующие каналы; для потребителей fallback-SMS (ADR-057)
delivery_attempt(id, notification_id FK, channel text
        CHECK (in in_app|push|email|sms),
     provider_message_id, status text, status_at)

domain_deadline(id, kind text, subject_type text, subject_id uuid,
     starts_from text CHECK (in cabinet_placement|event),  -- отсчёт от размещения в ЛК/события
     anchor_at timestamptz NULL,                  -- заполняется при размещении в ЛК
     deadline_at timestamptz NULL, paused bool, pause_reason text NULL,
     fired_at NULL, outcome text NULL)
     INDEX (deadline_at) WHERE fired_at IS NULL AND paused = false
```

**Audit Vault** (отдельная БД): `audit_entry(seq bigserial, actor, actor_role, action, target_type, target_id, payload jsonb, at, prev_hash, this_hash)`; `this_hash = sha256(prev_hash || canonical(entry))`; ежедневный якорь цепочки (checkpoint-хеш) штампуется в TSA — доказательство нередактируемости во времени (ADR-038).

## 5.3. Шифрование на уровне записи

Все поля `*_encrypted` — envelope encryption: данные шифруются DEK (AES-256-GCM), DEK шифруется KEK субъекта в KMS. `encryption_key_ref` указывает на запись реестра ключей `subject_key(subject_type, subject_id, kek_ref, destroyed_at NULL)`. Crypto-shredding = проставление `destroyed_at` + уничтожение KEK в KMS (§10.2). Закладывается с первой миграции (ADR-035: ретроспективно не добавляется). Хеши контактов (`phonebook_hash`, `personal_tax_id_hash`, стоп-листы) и `trust_id` — необратимы и в crypto-shredding не участвуют (не содержат раскрываемых ПД).

---

# 6. МАШИНЫ СОСТОЯНИЙ И СОБЫТИЙНАЯ МОДЕЛЬ

## 6.1. Согласование (Contract и Amendment — общая FSM)

| Переход | Кто | Условия и побочные эффекты |
|---|---|---|
| `draft → under_review` | Любая сторона (Representative: COMMUNICATE) | Контрагент определён; событие `negotiation.sent` |
| `under_review → under_review` | Обе | Итерации протокола разногласий; без лимита (ADR-009) |
| `under_review → rejected_by_counterparty` | Вторая сторона | Терминально, без влияния на репутацию |
| `under_review → withdrawn_by_initiator` | Инициатор | Терминально |
| `under_review → pending_signature` | Любая сторона | Нет открытых revision_proposal; **пересчёт `segment` (§6.6)**; создаётся ContractVersion: snapshot + sha256 + TSA; валидация: сумма листьев = сумма; для платных сегментов налоговый статус и реквизиты исполнителя заполнены (§6.2 п.7 концепции); проверки комплаенса (стоп-лист, НПД, СРО-предупреждения) |
| `pending_signature → awaiting_signatures` | Representative | Выбор подписанта из отфильтрованного по лимиту списка; SignatureRequest |
| `awaiting_signatures → pending_signature` | — | Тайм-аут запроса подписи / переадресация |
| `awaiting_signatures → under_review` | Подписант | `declined_for_revision`: заморозка снята, подписи аннулированы |
| `awaiting_signatures → signed` | Подписант | Обе подписи на одном integrity_hash; **в одной транзакции**: снепшоты полномочий, начисление и оплата комиссии за заключение деньгами (`contract_fee`, только для платных сегментов), для договора — `execution_status = pending_start`; события `contract.signed`, `contract.fee_charged` (если платный сегмент) |

Любая правка после `pending_signature` возвращает в `under_review` и удаляет активные SignatureRequest/подписи (ADR-006).

## 6.2. Исполнение договора

`pending_start → in_progress` — при проходе гейта первого листа. `in_progress → completed` — все листья `paid`. `completed → warranty → closed` — по датам. `in_progress → closed` (`auto_close_idle`, ADR-138) — 3 месяца без движения (действия стороны: этапы, платежи, споры, доказательства, сообщения чата, допники), предупреждение обеим сторонам за две недели; этапы `under_acceptance`/`accepted` откладывают закрытие на 14 дней с уведомлением; событие `contract.auto_closed`, минуя `completed`/`warranty`. `in_progress → terminated_by_customer` — всегда доступен заказчику (расчёт по §30–31); `→ terminated_by_contractor` — через окно оспаривания основания (ADR-028). «Приостановлен» — вычисляемый признак, в БД не хранится.

## 6.3. Этап (лист)

```
pending → in_progress            гейт: подписан + материалы + фин. условие
in_progress ⇄ suspended          уведомление о материалах, окно оспаривания (ADR-019);
                                 накопление frozen_days, сдвиг последующих дедлайнов
in_progress → under_acceptance   ТОЛЬКО формальная сдача (submit); непокрытые
                                 required_evidence НЕ блокируют её (ADR-164) —
                                 они подсказка; старт дедлайна приёмки
under_acceptance → accepted      явная приёмка ИЛИ тайм-аут (отсчёт от размещения
                                 уведомления в ЛК, ADR-057; усиленная серия напоминаний)
under_acceptance → disputed      отклонение только с checklist_item_id + evidence
disputed → under_acceptance      исправление сдано (round ≤ 2)
disputed → accepted              согласие/скидка (допник) /решение диалога
disputed → (закрыт по потолку)   30 дней: принятые листья оплачиваются, спорный
                                 возвращается; референсные метрики обеим сторонам
accepted → paid                  по способу расчёта (см. 6.5)
```

Фин. условие гейта по способам: `direct_platform` — авансовый платёж этапа наблюдён платформой (`observed`/`captured`); `hold` (Р2) — `held`; `prepayment` — двустороннее подтверждение; `cash`/`external` — выполнено по умолчанию + метка «без защиты платежа».

**Переход `pending → in_progress` — автоматический (ADR-162).** Лист входит в работу САМ в тот момент, когда закрывается ПОСЛЕДНЕЕ из трёх условий гейта: подтверждение получения материала, подтверждение оплаты (при `payment_order=before_start`) или подписание договора — смотря что закрылось позже. Ручного шага «Начать этап» в сценарии больше нет; эндпоинт `POST /milestones/{id}/start` остаётся идемпотентным запасным путём (см. §8.5). События `milestone.gate_passed`/`milestone.started` те же, у автостарта `actor` пуст и `payload.auto = true`; уведомление «Этап начался» получают обе стороны. Ветки дерева не стартуют — только листья.

## 6.4. Доменные события и лента объекта

Формат события (outbox → подписчики → лента):

```json
{
  "event_id": "uuid",
  "topic": "milestone.submitted",
  "occurred_at": "2026-07-22T12:00:00Z",
  "actor": {"user_id": "…", "profile_id": "…", "on_behalf_of_entity": "…"},
  "subject": {"type": "milestone", "id": "…", "contract_id": "…"},
  "payload": {"…": "…"},
  "schema_version": 1
}
```

Принцип §37a: одна запись события порождает (а) строку ленты объекта для UI, (б) уведомления, (в) запись в Audit Vault. Три потребителя — один источник.

Реестр топиков — по факту издателей (ADR-134; приведён к реальности 2026-08-26, коды, которые никто не эмитирует, убраны — `signature.*`, `contract.fee_*`, `payment.initiated|observed|captured|confirmed|refunded|failed`, `milestone.disputed`, `dispute.discount_signed`, `evidence.late|package_exported|retention_notice`):

- **contracts** (`apps/contracts/events.py::Topic` — единственный реестр в коде, литералы в `publish` запрещены тестом): `contract.drafted|draft_patched|draft_deleted|signed|amended|started|completed|warranty_started|closed|terminated`, `negotiation.sent|withdrawn|rejected|reopened|revised|frozen|signature_requested|signed|signature_forwarded|signature_request_expired`, `amendment.drafted|sent|frozen|signature_requested|signed|signature_forwarded|reopened|signature_request_expired|rejected|withdrawn` (`rejected|withdrawn` — `feat/contracts-amendment-reject`).
- **milestones**: `milestone.created|updated|deleted|checklist_item_added|checklist_item_updated|checklist_item_removed|material_added|material_received|gate_passed|started|suspended|resumed|submitted|accepted|auto_accepted|rejected|advance_confirmed|payment_confirmed|paid`.
- **payments** (ADR-130): `payment.created|payer_confirmed|payee_confirmed|paid|cancelled|overdue`.
- **disputes** (ADR-131): `dispute.opened|responded|fix_requested|fix_resubmitted|discount_proposed|discount_declined|resolved|cap_reached`, окна оспаривания `dispute.window_*`.
- **warranty**: `warranty.claim_submitted|claim_declined|claim_resolved`.
- **evidence**: `evidence.received|originals_deleted`; **messaging**: `message.created`; **deadlines**: `domain_deadline.fired` (`payload.kind` — вид дедлайна); **entity/compliance/social** — по своим приложениям (`entity.claimed|claim_disputed|epoch_changed`, `compliance.*`, `social.*`).

## 6.4a. Хроника договора (`GET /contracts/{id}/timeline`, ADR-134)

Read-модель прямо из outbox, без отдельной таблицы (`object_timeline` из §5 — план на объёмах). Состав ленты договора:

- собственные события договора (`subject.type=contract`) **кроме чата** (`message.created` — у переписки своя вкладка);
- **свёрнутые ключевые события дочерних сущностей** (`nested: true`), собранные из той же outbox-таблицы по `subject.contract_id` (издатели кладут его рядом со своим id — формат выше, ADR-126) или `payload.contract_id` (допники): `milestone.started|submitted|accepted|auto_accepted|rejected`, `amendment.sent|rejected|withdrawn` («подписан обеими» — `contract.amended` на самом договоре), `dispute.opened|resolved`, `payment.paid` (`milestone.paid` — дубль того же факта из зеркала, не показывается), `warranty.claim_submitted|claim_declined|claim_resolved`. Рабочий шум (`milestone.gate_passed`, `payment.created`, `dispute.responded`…) — только в ленте самой сущности (`/milestones/{id}/timeline`).

Порядок — `occurred_at`, тай-брейк `event_id` (uuid7). Элемент (`TimelineEventSerializer`, тот же у `/amendments/{id}/timeline` и `/milestones/{id}/timeline`):

| Поле | Значение |
|---|---|
| `event_id`, `topic`, `occurred_at`, `actor`, `payload` | как в outbox (совместимость: `topic`/`payload` не меняются) |
| `kind` | **стабильный ключ представления** — `apps/contracts/events.py::timeline_kind`. Для однозначных топиков `kind == topic`; для многозначных — суффикс по payload: `negotiation.revised.proposed\|accepted\|rejected\|countered\|accept_all\|alternative` (`payload.action`, `via=accept_all`), `negotiation.reopened.returned\|declined` (`payload.reason`), `contract.terminated.by_customer\|by_contractor` (`payload.terminated_by`), `deadline.warranty_expired\|termination_window_closed` (`domain_deadline.fired`, `payload.kind=contract_warranty\|termination_dispute_window`). Без различителя — `kind == topic`. Полный список — `events.TIMELINE_KINDS`; ключ подписи в l10n-паках (`ui.timeline.<kind>`) и опора фронта для иконок/группировки |
| `title`, `detail` | **подпись события на языке запроса** (`common.i18n.resolve_request_locale`: `user.locale` → страна → Accept-Language → default; фолбэк пакета locale → en) из l10n-паков, namespace `ui`: `timeline.<kind>` — заголовок, `timeline.<kind>.detail` — короткая подпись с подстановками из payload (`{milestone_title}`, `{item}`, `{amount} {currency}`, `{comment}`, `{reason}`, `{description}`). Фронт не переводит. Нет текста — `title: null` (фронт показывает `kind`); нет шаблона или значения для плейсхолдера — `detail: null` |
| `nested` | `true` — событие дочерней сущности, показывается свёрнуто |
| `subject` | `{type, id, title}` — ссылка: `type` ∈ `contract\|milestone\|amendment\|dispute\|payment\|warranty_claim`; `title` — только если издатель положил его в событие (`milestone_title`), иначе `null` |

## 6.5. Платёжная FSM (прямой платёж, ADR-055/056)

```
pending → processing → captured      сплит СБП: деньги исполнителю; комиссия платформы
                                     0% (ADR-055). На получателе — только тариф
                                     платёжного оператора (operator_fee)
pending → observed                   прямой платёж наблюдён платформой (целевой, ADR-056)
processing → failed                  ошибка провайдера; ретраи идемпотентны
captured → refunded                  возврат (тариф оператора возврата — по правилам оператора)
```

Для офлайн-способов: `pending → confirmed` (оба подтверждения) / `→ disputed` (расхождение). Каждая операция с деньгами требует `Idempotency-Key` (§7.6) и пишет обе раскладки до подтверждения (§42 концепции: исполнитель видит «сумма → тариф оператора → к получению» ещё до подписания — раскладка также включается в snapshot версии договора). **Комиссия платформы за платёж отсутствует** — платформа зарабатывает на разовой комиссии за заключение (§6.6, `contract_fee`), а не на движении денег.

## 6.6. Сегментация договора (ADR-058)

`compute_segment(contract) -> segment` — чистая функция, вызывается при создании договора и пересчитывается при смене типа/сторон до заморозки (§6.1). Вход: `contract_type_code` (и его `default_segment`, `requires_service_flag`, `needs_special_handling`), `deal_type`, бизнес-статус исполнителя (`contract_party[contractor].acting_as` + `user.has_business_status`).

Правила (закрытый список, покрыт тестами):

1. Тип из **белого списка бесплатного C2C** (`default_segment=free_c2c`: займы физлиц, купля-продажа/дарение личного имущества, урожай ЛПХ и т.п.) и обе стороны — физлица → **`free_c2c`**, комиссия за заключение не берётся.
2. **Возмездная услуга** (`requires_service_flag=true`), исполнитель — **физлицо без бизнес-статуса** (`acting_as=person`, `has_business_status=false`), заказчик — любой → **`free_c2c`** («плавный вход в предпринимательство»); инкремент `self_employment_prompt`, показ напоминания о регистрации СМЗ. **Бизнес-статус — только собственный СМЗ/ИП; активное представительство чужого юрлица статуса не даёт (§14 п.16).**
3. Исполнитель — **бизнес** (`acting_as=business` или `has_business_status=true`), либо любой иной возмездный тип вне белого списка → **`paid_business`**, берётся комиссия за заключение.
4. Типы `needs_special_handling` (недвижимость/транспорт; аренда/наём личного имущества между физлицами) → **`special`**: комиссия берётся, но договорный модуль требует отдельной проработки (П-15, Релиз 2).
5. Типы с `default_segment=excluded` (реализация долей в УК, паёв, ценных бумаг) → **`excluded`**: создание запрещено (`403 contract_type_excluded`), тип скрыт из каталога (`is_hidden=true`). Платформа такие сделки не готовит.

`contract_fee` создаётся только для `paid_business` и `special`.

---

# 7. API: ОБЩИЕ ПОЛОЖЕНИЯ

## 7.1. Базовые соглашения

- **Базовый URL:** `https://api.<domain>/v1/`. Версия — в пути; ломающие изменения = новая мажорная версия; расширяющие (новые поля/эндпоинты) — без смены версии, клиенты обязаны игнорировать неизвестные поля.
- **Формат:** JSON (UTF-8), `Content-Type: application/json`; файлы — multipart или прямая загрузка в хранилище по pre-signed URL (доказательства — только через Evidence Ingest, §8.9).
- **Имена полей:** snake_case, как в доменной модели. Деньги: `{"amount": "15000.00", "currency": "RUB"}` — суммы всегда строкой (без потери точности).
- **Время:** ISO 8601 с зоной (`2026-07-22T12:00:00+03:00`), хранение в UTC.
- **Идентификаторы:** UUID (внутренние ключи); публичная адресация пользователей/групп — по `@handle`.
- OpenAPI 3.1 генерируется drf-spectacular и публикуется на `/v1/schema/` (+ Swagger UI на internal-окружениях).

## 7.2. Аутентификация и сессии

- **Основной механизм:** OAuth 2.1-совместимый собственный auth-сервер поверх `accounts`: короткоживущий **access-токен (JWT, 60 мин — ADR-108; было 15)** + **refresh-токен (30 дней, ротация, привязка к устройству)**. Заголовок `Authorization: Bearer <jwt>`.
- **Входы:** телефон+SMS-код, email+пароль (базовый уровень, ФЗ-406) · **ЕСИА OAuth** (строгая верификация, ADR-052) — отдельный флоу `POST /v1/auth/esia/…`, повышающий `verification_level` до `verified`.
- **Мобильное устройство** дополнительно регистрирует DeviceKey (§8.9): пара ключей генерируется на устройстве, публичный ключ отправляется на сервер.
- Внутренний служебный контур (backoffice) — отдельный домен/приложение с собственной аутентификацией (SSO + 2FA), в публичном API отсутствует.

## 7.3. Контекст актёра: от чьего имени действие

Пользователь может представлять несколько юрлиц и действовать как физлицо или как бизнес. Каждый запрос, совершающий доменное действие, выполняется **в контексте профиля**:

```
X-Acting-Profile: <profile_id>
```

Сервер проверяет: профиль принадлежит пользователю (профиль физлица или бизнес-профиль) **или** его юрлицу, у которого пользователь — активный Representative с нужным Permission (проверка по permissions, не по role). Качество, в котором пользователь входит в договор (`person`/`business`), определяет сегмент сделки (§6.6). Отсутствие заголовка допустимо только для «личных» эндпоинтов (`/users/me`, справочники). Контекст фиксируется в каждом событии (`actor.on_behalf_of_entity`) и в Audit Vault.

## 7.4. Авторизация (permissions)

Три уровня проверки на каждый доменный эндпоинт:

1. **Аутентификация + verification_level** (progressive KYC, концепция §10): строгая верификация требуется на пороге чувствительного действия — подписание, выплата, claim, суммы выше лимита. Ошибка `403 verification_required` с указанием требуемого уровня — клиент показывает флоу ЕСИА.
2. **Операционные права** Representative (`Permission`) — для действий от имени юрлица.
3. **Доменные гейты**: `assert_entity_operable` (claim), `SigningAuthority.is_valid_now()` + лимит суммы (подписание), участие в договоре (все операции над договором), приватность связей и контактов (видит только владелец), `assert_segment_creatable` (нельзя создать `excluded`-тип).

## 7.5. Ошибки

`application/problem+json` (RFC 9457) + машиночитаемый доменный код:

```json
{
  "type": "https://api.trust.example/errors/contract_fee_charge_failed",
  "title": "Не удалось списать комиссию за заключение договора",
  "status": 409,
  "code": "contract_fee_charge_failed",
  "detail": "Платёж комиссии отклонён провайдером. Договор не вступил в силу.",
  "context": {"fee": {"amount": "900.00", "currency": "RUB"}, "provider_error": "…"},
  "trace_id": "…"
}
```

Соглашения по статусам: `400` — невалидный запрос; `401`; `403` — нет права (в т.ч. `verification_required`, `entity_not_operable`, `signing_authority_required`, `contract_type_excluded`); `404` — нет или невидим (приватность связей/контактов отдаёт 404, а не 403 — существование скрывается); `409` — конфликт состояния/FSM (`invalid_state_transition`, `version_stale`, `checklist_item_required`, `contract_fee_charge_failed`, `npd_limit_exceeded` …); `422` — доменная валидация; `429` — rate limit. Полный реестр `code` ведётся в OpenAPI как enum и является частью контракта.

## 7.6. Идемпотентность и конкурентность

- Все небезопасные POST по деньгам, подписям и сдаче этапов принимают заголовок **`Idempotency-Key`** (UUID клиента). Повтор с тем же ключом возвращает первый результат (хранение 72 ч).
- Оптимистическая блокировка редактируемых ресурсов: `ETag`/`If-Match` по `updated_at`-версии; расхождение — `409 version_stale`.
- Подпись всегда адресуется **integrity_hash версии** — подписать «не то» невозможно по построению (ADR-006).

## 7.7. Пагинация, фильтрация, поиск

Cursor-пагинация: `?cursor=…&limit=50` (max 100), ответ `{"results": […], "next_cursor": "…"}`. Фильтры — плоские query-параметры (`?status=in_progress&sphere=renovation`). Полнотекстовый поиск — параметр `q` на каталожных эндпоинтах.

## 7.8. Rate limiting и защита

По токену и IP (Redis): базово 600 rpm на пользователя, 60 rpm на «дорогие» операции (создание договора, экспорт пакета), 10 rpm на денежные операции, отдельный жёсткий лимит на загрузку хешей телефонной книги (антиперебор). Ответ `429` + `Retry-After`. Плюс: CORS-белый список, TLS 1.3, HSTS, подпись webhook'ов провайдеров (§9), антивирусная проверка загружаемых файлов.

## 7.9. Локализация

`Accept-Language` (ru — базовый). Справочники отдают `name_i18n`; тексты ошибок локализуются, `code` — нет.

---

# 8. API: РЕСУРСЫ И ОПЕРАЦИИ

Формат описания: метод и путь · назначение · требуемые права. Тела показаны для несущих операций; остальные схемы — в OpenAPI. Все пути — от `/v1`.

## 8.1. Аутентификация и пользователь

| Метод и путь | Назначение |
|---|---|
| `POST /auth/otp/request` · `POST /auth/otp/verify` | Вход по телефону: запрос и проверка SMS-кода → пара токенов |
| `POST /auth/token/refresh` · `POST /auth/logout` | Ротация refresh / отзыв |
| `GET /auth/esia/authorize-url` | URL для редиректа в ЕСИА (state, PKCE) |
| `POST /auth/esia/callback` | Код ЕСИА → верификация: `verification_level=verified`, подтверждённые ФИО/ИНН; фоново — авто-claim юрлиц и связывание director_user (ADR-044) |
| `GET /users/me` | Профиль пользователя: `trust_id`, `@handle`, уровень верификации, профили (физлицо/бизнес), `has_business_status`, представительства, доступные юрлица |
| `PATCH /users/me` · `DELETE /users/me` | Правка контактов · запрос на удаление ПД (crypto-shredding, §10.2; 202 + процесс) |
| `POST /users/me/devices` | Регистрация устройства + push-токен |
| `POST /users/me/devices/{id}/device-key` | Регистрация публичного ключа устройства (ADR-053) |

## 8.1b. Идентичность, хендлы, граф доверия, объединения (social)

| Метод и путь | Назначение |
|---|---|
| `GET /handles/{handle}` | Публичная карточка по @username: имя (если раскрыто), профили, объединения. `trust_id` не раскрывается |
| `POST /users/me/handle` | Занять/сменить @username: `{"value": "ivan_master"}`; уникальность citext; при смене прежние ссылки инвалидируются (хендл ≠ личность) |
| `POST /users/me/phonebook` | Загрузка **необратимых хешей** номеров телефонной книги: `{"hashes": ["…"], "algorithm": "…", "salt_ref": "…"}` → список найденных на платформе (по совпадению хешей); сырые номера не принимаются и не хранятся (152-ФЗ) |
| `GET /users/me/contacts` | Граф доверия: мои контакты (приватно; чужие рёбра невидимы — `404`) |
| `POST /users/me/contacts` · `DELETE /users/me/contacts/{id}` | Добавить/удалить контакт (manual/deal/link); `is_mutual` — при встречном ребре |
| `GET /users/me/reputation-link` · QR | Ссылка/QR на публичную карточку репутации (шаринг вне платформы) |
| `GET /groups` · `POST /groups` | Объединения-витрины: список · создать (`kind`, `name`, лидер = актёр). Группа НЕ сторона договора |
| `GET /groups/{id}` · `PATCH` | Карточка объединения (агрегированная витрина участников) · правка (лидер/админ) |
| `POST /groups/{id}/members` · `PATCH/DELETE /groups/{id}/members/{uid}` | Приглашение/роль/исключение участника; лидер подписывает договоры от своего имени, не от имени группы |

## 8.2. Юрлица, claim, полномочия

| Метод и путь | Назначение |
|---|---|
| `POST /business-entities` | Онбординг по одному идентификатору (ADR-044). Тело: `{"country": "RU", "tax_id": "7701234567"}` → карточка из реестра, `claim_status`, результат авто-claim |
| `GET /business-entities/{id}` · `PATCH` | Карточка · ручные поля (налоговый режим, банковские реквизиты, контакты) |
| `GET /business-entities/{id}/claim-methods` | Доступные способы подтверждения контроля с оценкой трения |
| `POST /business-entities/{id}/claim` | Claim выбранным способом: `{"method": "organization_esignature", "proof": {…}}` → `claimed` или `pending` |
| `POST /business-entities/{id}/claim/dispute` | Возврат захваченной карточки (директор по реестру побеждает, ADR-042) |
| `GET/POST /business-entities/{id}/representatives` | Список/приглашение Representative (permissions в теле; требует MANAGE_REPRESENTATIVES) |
| `PATCH/DELETE /business-entities/{id}/representatives/{rid}` | Изменение прав / деактивация |
| `GET/POST /business-entities/{id}/signing-authorities` | Список/выдача права подписи. Тело: `{"user_id": …, "basis": "registry_verified_director" | "notarized_poa" | …, "max_amount": {…}, "proof": {…}}`. Проверки ADR-004 (для форм с has_separated_ownership ручная экспертиза запрещена — `403`) |
| `DELETE /business-entities/{id}/signing-authorities/{sid}` | Отзыв (не затрагивает уже поставленные подписи — снепшот ADR-005) |
| `GET /business-entities/{id}/epochs` | Эпохи владения (публичная часть) |
| `POST /business-entities/{id}/epochs/appeal` | Обжалование перехода эпохи (ADR-014) |
| `PUT /business-entities/{id}/stop-list` | Загрузка стоп-листа ИНН лиц, с которыми у заказчика-юрлица уже есть иные правоотношения (заказчик-юрлицо, §6.2; хранится хешами) |

## 8.3. Профили, портфолио, членства

| Метод и путь | Назначение |
|---|---|
| `POST /profiles` | Создать профиль: `{"kind": "person"}` (профиль физлица) или `{"kind": "business", "owner": {"entity_id": …}}` |
| `GET /profiles/{id}` | Публичная карточка: факты репутации по сферам (обе оси, эпохи — если были), портфолио, членства, метка «без защиты платежа» в статистике |
| `PATCH /profiles/{id}` | Свои поля профиля (bio, сферы, витрина) |
| `GET /profiles/{id}/reputation` | Репутация по сферам: `{"sphere": "renovation", "rating_facts": {"completed": "148/156", "on_time": "141/156", …}, "deals": 156, "volume": {"amount": "48000000", "currency": "RUB"}, "epochs": […]}` |
| `GET /profiles/{id}/reputation/insights` | **Только владелец**: вклад каждого договора в каждую метрику (§24a) |
| `POST /reputation-appeals` | Обжалование референсного значения (ФЗ-289, §29) |
| `GET/POST /profiles/{id}/portfolio/projects` | Проекты портфолио; `POST /portfolio/projects/from-contract` — сборка из договора (`selected_media`, verified_facts заполняет система) |
| `POST /portfolio/projects/{id}/publish` | Публикация; для FROM_CONTRACT требует consent второй стороны |
| `POST /portfolio/consents/{id}/grant|refuse` | Согласие второй стороны на публикацию |
| `GET /communities` · `POST /profiles/{id}/memberships` | Справочник объединений · заявление членства (verified — после сверки с реестром объединения) |

## 8.4. Договоры: черновик и согласование

| Метод и путь | Назначение |
|---|---|
| `POST /contracts` | Создать черновик. Тело: `contract_type_code` (из каталога типов), стороны (контрагент — по profile_id/@handle/инвайту, с `acting_as`), sphere, payment_method, шаблон/свободная редакция, `source_contract_id` («как в прошлый раз», ADR-050). Сервер считает `segment` (§6.6); `excluded`-тип → `403 contract_type_excluded` |
| `GET /contracts` | Мои договоры (фильтры: роль, статусы, sphere, segment) |
| `GET /contracts/{id}` | Полная карточка: оба статуса, `contract_type_code`, `segment`, раскладка комиссии за заключение (если платный сегмент), вычисляемые признаки (`is_suspended`), действующая редакция (склейка допников), гейты |
| `PATCH /contracts/{id}` | Правка черновика (до `under_review` — свободная); смена типа/сторон пересчитывает `segment` |
| `POST /contracts/{id}/send` | Отправить контрагенту → `under_review` |
| `GET/POST /contracts/{id}/revisions` | Протокол разногласий: список/новое предложение правки `{"item_ref": "milestones[2].amount", "new_value": …, "comment": …}` |
| `POST /revisions/{rid}/accept` · `/reject` · `/counter` | Принять / отклонить / встречная редакция |
| `POST /contracts/{id}/revisions/accept-all` | «Принять все» — при финансово значимых правках требует `confirm_summary: true` и возвращает список «было → стало» для явного подтверждения (§13.2) |
| `GET/POST /contracts/{id}/preapproved-alternatives` | Предодобренные альтернативы пункта; `POST /preapproved-alternatives/{id}/apply` — принятие одним кликом без новой итерации |
| `POST /contracts/{id}/withdraw` · `/reject` | Отозвать (инициатор) · отклонить (контрагент) — терминальные |
| `GET /contracts/{id}/timeline` | Лента событий объекта (§37a) — единая хроника для UI и доказательства; состав и контракт элемента (`kind`, `nested`, `subject`) — §6.4a, ADR-134 |

**Заморозка и подписание:**

| Метод и путь | Назначение |
|---|---|
| `POST /contracts/{id}/freeze` | Нет открытых правок → пересчёт `segment` → ContractVersion (snapshot, sha256, TSA) → `pending_signature`. Ошибки: `422 open_revisions`, `422 leaf_sum_mismatch`, `409 requisites_missing` (для платных сегментов налоговый статус/реквизиты — условие подписания, §6.2 п.7), комплаенс-предупреждения в теле ответа |
| `GET /contracts/{id}/versions/{vid}` | Замороженная версия: snapshot + integrity_hash + приложение для проверки |
| `GET /contracts/{id}/fee-preview` | Раскладка комиссии за заключение по текущей сумме (маржинальная шкала); для `free_c2c`/`excluded` — `{"fee": null, "segment": "free_c2c"}` |
| `GET /contracts/{id}/signatories?side=customer` | Доступные подписанты, отфильтрованные по лимиту суммы |
| `POST /contracts/{id}/signature-requests` | Адресный запрос: `{"version_id": …, "signatory_user_id": …}` → `awaiting_signatures` |
| `GET /signature-requests/{id}` | Для подписанта: финальный текст, история изменений, **AI-резюме существенных условий** (`summary`, факт показа фиксируется — §14.3), раскладка комиссии за заключение, дисклеймер |
| `POST /signature-requests/{id}/sign` | Подписать: `{"version_hash": "…", "esign": {…}}` — хеш обязателен в теле (подпись на версию, ADR-006); провайдер УНЭП/Госключ — по JurisdictionConfig. При второй подписи: транзакция «signed + снепшоты + оплата комиссии за заключение (платный сегмент)»; `409 contract_fee_charge_failed` при отказе платежа комиссии |
| `POST /signature-requests/{id}/forward` | Переадресация другому подписанту (договор не меняется) |
| `POST /signature-requests/{id}/decline` | На доработку: причина; заморозка снята, подписи аннулированы → `under_review` |

Пример ответа `POST /signature-requests/{id}/sign` (вторая подпись, платный сегмент; комиссия по маржинальной шкале: 50 000 × 1% + 50 000 × 0,8% + 20 000 × 0,6% = 1 020 ₽):

```json
{
  "contract_id": "…",
  "negotiation_status": "signed",
  "execution_status": "pending_start",
  "signed_version_hash": "sha256:ab12…",
  "segment": "paid_business",
  "contract_fee": {
    "base": {"amount": "120000.00", "currency": "RUB"},
    "fee": {"amount": "1020.00", "currency": "RUB"},
    "effective_rate": "0.0085",
    "status": "charged"
  },
  "payee_breakdown": {
    "total": {"amount": "120000.00", "currency": "RUB"},
    "platform_commission": {"amount": "0.00", "currency": "RUB"},
    "operator_fee_estimate": {"amount": "480.00", "currency": "RUB"},
    "net_to_receive": {"amount": "119520.00", "currency": "RUB"}
  }
}
```

Для `free_c2c` объект `contract_fee` равен `null`, `platform_commission` — `0.00`.

## 8.5. Этапы, чек-листы, материалы

| Метод и путь | Назначение |
|---|---|
| `GET /contracts/{id}/milestones?view=tree` | Дерево этапов; у веток — вычисленные сумма/статус |
| `POST /contracts/{id}/milestones` · `PATCH/DELETE /milestones/{id}` | Редактирование структуры (DELETE — ADR-101, поддерево каскадом) — только в статусах черновика/согласования; после подписания `409 contract_immutable` (только через допник) |
| `GET/POST /milestones/{id}/checklist-items` | Пункты чек-листа (до подписания) |
| `GET /milestones/{id}/checklist-recommendations` | Рекомендация пунктов по материалам + базовые пункты сферы (ADR-047) |
| `GET/POST /milestones/{id}/materials` | Материалы листа; валидация: catalog_item обязателен («Прочее» доступно всегда), описание обязательно, правило цены |
| `POST /materials/{id}/problem-notice` | Уведомление о проблеме с материалами → окно оспаривания (ADR-019) |
| `POST /materials/{id}/received` | Подтверждение получения → разморозка зависимых этапов |
| `POST /milestones/{id}/request` | Запрос материалов/информации/доступа с дедлайном |
| `POST /milestones/{id}/extension-request` | Запрос отсрочки (Representative достаточно) |

`GET /milestones/{id}/gate` — состояние трёх условий старта (`conditions`: `waiting`/`met`/`not_required`, ADR-155) и `can_start`. `POST /milestones/{id}/start` — ручной старт листа; с ADR-162 он РЕДКИЙ: лист стартует сам в момент закрытия последнего условия (§6.3), а эндпоинт остаётся идемпотентным (`in_progress` → no-op) для обратной совместимости и рассинхрона клиента.

**Сдача и приёмка:**

| Метод и путь | Назначение |
|---|---|
| `POST /milestones/{id}/submit` | **Формальная сдача** (только так, §16.2): `{"evidence_ids": […], "comment": …}`. Непокрытые `required_evidence` сдачу НЕ блокируют (ADR-164, решение владельца 05.09: это рекомендация чек-листа, а не гейт; непокрытые пункты видны в `uncovered_required_evidence` карточки этапа, заказчик отклоняет по ним при приёмке). → `under_acceptance`, создаётся дедлайн приёмки (отсчёт от размещения уведомления в ЛК, ADR-057), стартует усиленная серия напоминаний |
| `POST /milestones/{id}/accept` | Приёмка заказчиком → `accepted`; триггер расчёта по способу. Окно приёмки закрывается досрочно (дедлайн `milestone_acceptance` получает `fired_at`/`outcome=accepted` без события срабатывания) — оставшиеся точки усиленной серии напоминаний не уходят |
| `POST /milestones/{id}/reject` | Отклонение: `{"checklist_item_id": "…", "evidence_ids": […]}` — без пункта чек-листа `422 checklist_item_required` (ADR-017) → Dispute. Окно приёмки закрывается (`outcome=rejected`), серия напоминаний прекращается; новое окно и новая серия — только при повторной сдаче после исправления (§8.8) |
| `GET /milestones/{id}/acceptance` | Состояние окна приёмки: дедлайн, факт размещения уведомлений в ЛК, часов осталось |

## 8.6. Допники

| Метод и путь | Назначение |
|---|---|
| `POST /contracts/{id}/amendments` | Черновик допника: `{"reason": …, "changes": [{"type": "add_milestone", "payload": {…}}, {"type": "modify_material", "target": …, "payload": …, "amount_delta": {…}}], "custom_terms": …}` |
| `GET /amendments/{id}` | Карточка: изменения, вычисленные `amount_delta`, `days_delta`, новая сумма договора, доначисление комиссии за заключение по дельте (платный сегмент) |
| Согласование/заморозка/подписание | Те же эндпоинты, что у договора (общая FSM): `/amendments/{id}/send`, `/revisions`, `/freeze`, `/signature-requests` … |
| Вступление в силу | После второй подписи: применение изменений; дельта > 0 в платном сегменте — доначисление комиссии за заключение по маржинальной шкале от новой суммы (ADR-054 rev2); при `hold` (Р2) — доп. блокировка, неуспех → допник не вступает (`409 additional_hold_failed`); дельта < 0 — комиссия не возвращается (невозвратна) |

Валидации: `422 milestone_already_accepted` (нельзя удешевить/убрать принятое), `422 material_already_received`.

## 8.7. Платежи и комиссия за заключение

| Метод и путь | Назначение |
|---|---|
| `GET /contracts/{id}/payment-plan` | План расчётов по листьям: аванс/постоплата, статусы, раскладка «сумма → тариф оператора → к получению» **до** операций (комиссии платформы за платёж нет) |
| `POST /milestones/{id}/payments` | Инициировать платёж (заказчик): `{"kind": "advance"|"postpayment", "idempotency_key": …}` → платёжная ссылка/QR СБП провайдера. **Комиссия платформы 0%**; на получателе — тариф платёжного оператора |
| `GET /payments/{id}` | Статус операции + обе раскладки |
| `POST /payments/{id}/confirm` | Двустороннее подтверждение офлайн-способов: `{"side": "payer"|"payee"}`; расхождение по итогам окна → `disputed` |
| `POST /payments/{id}/refund` | Возврат (заказчику); тариф оператора возврата — по правилам оператора |
| `POST /provider-webhooks/{provider}` | Вебхуки платёжных партнёров (подпись провайдера обязательна; идемпотентная обработка) |
| `GET /contracts/{id}/contract-fee` | Комиссия за заключение: база, ставка, сумма, статус (`pending/charged/failed`); для `free_c2c`/`excluded` — `null` |
| `GET /billing/fee-preview?amount=…&contract_type_code=…&contractor_business=…` | Предпросчёт комиссии за заключение по маржинальной шкале и сегменту (без создания договора) |
| `GET /payout-accounts` · `POST` | Реквизиты выплат исполнителя (условие подписания в платных сегментах) |

Эскроу-холд (Р2, фича-флаг): `POST /milestones/{id}/payments` с `method=hold`, статусы `held/voided/captured`, переавторизация — фоновая (ADR-025); API-контракт закладывается сразу, чтобы клиенты не менялись.

Комиссии за заключение нет для `free_c2c`: платные C2C-услуги между физлицами (исполнитель без бизнес-статуса) проходят бесплатно; при накоплении таких сделок пользователь получает напоминание о регистрации самозанятости (`compliance.self_employment_suggested`, §6.6).

## 8.8. Споры и инструменты диалога

| Метод и путь | Назначение |
|---|---|
| `GET /disputes` · `GET /disputes/{id}` | Мои споры: пункт чек-листа, доказательства обеих сторон, дней до потолка |
| `POST /disputes/{id}/fix-requests` | Раунд исправления (максимум 2 — `409 fix_rounds_exhausted`) |
| `POST /disputes/{id}/fix-requests/{fid}/resubmit` | Исправление сдано → снова `under_acceptance` |
| `POST /disputes/{id}/discount-proposal` | Согласованная скидка: создаёт допник (требует подписи, ADR-048); анти-waiver: скидка закрывает только указанный дефект (§20.3) — фиксируется в payload |
| `POST /disputes/{id}/resolve` | Закрытие по согласию сторон |
| `POST /disputes/{id}/mediation` | Запрос медиации (согласие обеих сторон; оплата — по асимметрии §20.4) |
| `GET /disputes/{id}/experts` | Каталог аккредитованных оценщиков (перенаправление, платформа не участвует) |
| `POST /contracts/{id}/terminate` | Расторжение: `{"initiator_role": "customer"}` — всегда; `"contractor"` — с основанием, через окно оспаривания (ADR-028). Ответ — расчёт закрытия по §30 |
| `GET/POST /contracts/{id}/warranty-claims` | Гарантийные заявки (отдельная метрика, рейтинг не пересчитывается) |
| `GET /dispute-windows` | Активные окна оспаривания текущего профиля (для дашборда) |

## 8.9. Доказательства (Evidence Ingest)

| Метод и путь | Назначение |
|---|---|
| `GET/POST /contracts/{id}/assignments` | Назначения на съёмку (ADR-053): representative + этапы + период; отзыв не аннулирует снятое в период действия |
| `POST /evidence/batches` | **Приём офлайн-пакета** с мобильного: multipart, каждый элемент = файл + подписанный DeviceKey манифест `{sha256, captured_at_device, geo, contract_id, milestone_id, checklist_item_id, assignment_id, clock_sync}`. Сервер: проверка подписи и назначения → S3 (Object Lock) → TSA → расчёт `lateness` по окну выгрузки (72 ч, параметр категории) → ответ с подтверждениями по каждому элементу (клиент чистит локальные копии) |
| `POST /contracts/{id}/evidence` | Загрузка не-доказательных файлов с веба (документы; `is_evidence_role=false`) |
| `GET /contracts/{id}/evidence` | Реестр: метки раздельно («снято по часам устройства…», «получено…», «загружено с задержкой N дней») |
| `GET /evidence/{id}/download` | Pre-signed URL (оригинал — участникам договора; портфолио получает очищенную копию) |
| `GET /contracts/{id}/archive` | Превью состава архива + `retention` + список экспортов и ссылок стороны (ADR-139, `apps.archive`) |
| `POST /contracts/{id}/archive/export` | Экспорт (заменяет `POST /contracts/{id}/evidence-package` спеки 2.0.2): `{include_originals, manifest_only}` + `Idempotency-Key` → 202 `{export_id, jobId, status}`; Celery-задача собирает `package.zip` (manifest.json, SHA256SUMS, README, index.html, verify.py, чекпойнт + .tsr) и `files.zip` (оригиналы, миниатюры) — шифротекст конверта в бакете; уведомление `archive.ready` обеим сторонам + юрзначимое письмо с пакетом во вложении (< 20 МБ) независимо от настройки e-mail; бесплатно (ADR-036/137/139). PDF-оглавление — позже (нет WeasyPrint), вместо него `index.html` |
| `GET /contracts/{id}/archive/export/{export_id}` | Состояние сборки: `queued\|running\|ready\|failed`, `package`/`zip` со ссылками стороны, `pdf: null` |
| `POST /archive/links/{id}/revoke` | Отзыв долгоживущей ссылки любой стороной договора |
| `GET /a/<token>` | Без авторизации, в корне сайта (не /v1): zip стримом с `Cache-Control: private, no-store`, рейт-лимит по адресу, лог обращений в Vault; после удаления файлов по сроку — 410 с датой, хешами, `SHA256SUMS` и ссылкой на пакет (ADR-137 «ссылка живёт дольше данных») |
| `GET /contracts/{id}/retention` | Таймер хранения: до какого числа, пауза при споре, тариф (механика платного хранения — фича-флаг) |

## 8.10. Документы

| Метод и путь | Назначение |
|---|---|
| `GET /contracts/{id}/documents` | PDF договора/допников (генерация из snapshot), акты, чеки |
| `POST /milestones/{id}/closing-documents` | Формирование закрывающих: тип — из `LocalTaxRegime.closing_document_types` (чек НПД через партнёрский API ФНС; акт — генерация платформой в Р1, EDI в Р2) |
| `GET /documents/{id}` | Метаданные + pre-signed URL; хеш для проверки |

## 8.11. Маркетплейс (Пути Б/В/Г)

| Метод и путь | Назначение |
|---|---|
| `GET/POST /project-requests` | Заявки заказчиков (Путь Б); публикация — только operable-профиль |
| `POST /project-requests/{id}/responses` | Отклик исполнителя (бесплатно — антипаттерн §4a п.1) |
| `GET /search/contractors?sphere=…&q=…` | Каталог исполнителей (Путь В): факты репутации, обе оси, без единого балла |
| `GET /search/customers?open_to_offers=true` | Каталог заказчиков-посредников (Путь Г) |
| `POST /contracts` c `counterparty_invite` | Путь А: договор с контрагентом вне платформы — инвайт по телефону/email/@handle |

## 8.12. Субподряд: связи договоров

| Метод и путь | Назначение |
|---|---|
| `POST /contract-links` | `{"parent_contract_id": …, "child_contract_id": …}`; требование: актёр — участник обоих (ADR-040). Согласие сторон не требуется, связь приватна |
| `GET /contract-links?parent=…` | Только создателю; остальным `404` |
| `PUT /contract-links/{id}/milestone-map` | Сопоставление этапов |
| `GET /contract-links/{id}/sync-hints` | Подсказки: затронутые субподряды при сдвигах, зависимости оплат (никаких автодействий — только допником) |
| `POST /contract-links/{id}/prefill-checklist` | Чек-лист родительского этапа → заготовка чек-листа субподряда |
| `GET /dashboards/contractor/linked-margins` | Сводная маржа по связкам — только создателю связей |

## 8.13. Дашборды, уведомления, справочники

| Метод и путь | Назначение |
|---|---|
| `GET /dashboards/contractor` · `GET /dashboards/customer` | Агрегаты §44a (вычисляемые селекторы, собственных таблиц нет); каждый элемент содержит `action` — deep-link операции «в один клик» |
| `GET /notifications` · `POST /notifications/{id}/read` | Лента уведомлений (личный кабинет — юридически значимый канал, ADR-057); `read` фиксирует прочтение |
| `GET /notification-settings` · `PUT` | Каналы дублирования (push/email/SMS). **Личный кабинет — базовый юрканал, отключить нельзя**; email/SMS — опциональные дубли, для потребителей включён fallback-SMS (ADR-057) |
| `GET /contract-types?deal_type=…` | Каталог типов договоров (сегменты видимы: `free_c2c`/`paid_business`/`special`); `excluded`/`is_hidden` не отдаются |
| `GET /jurisdictions/{code}` | Конфигурация страны: формы, режимы (каскад), провайдеры, гарантийные рекомендации |
| `GET /jurisdictions/{code}/entity-forms` · `/tax-regimes?form=…` | Каскадные справочники (ADR-043) |
| `GET /spheres` · `GET /material-catalog?sphere=…&q=…` | Сферы · номенклатура материалов (+ «Прочее» всегда) |
| `GET /compliance/dashboard` | Юрлицу-заказчику: риски переквалификации по исполнителям (§6.2 п.8); физлицу — счётчик платных C2C-услуг и напоминание о самозанятости |

## 8.14. Партнёрское API и вебхуки платформы

Заложено, по умолчанию выключено (ADR-027): OAuth client-credentials для партнёров, подписка на вебхуки (`contract.signed`, `milestone.accepted`, `payment.captured` — темы из §6.4), подпись HMAC + ротация секретов. В Р1 реализуется только внутренний механизм подписок (используется вебхуками платёжных провайдеров) — публичный доступ закрыт фича-флагом.

---

# 9. ИНТЕГРАЦИИ И ПРОВАЙДЕРЫ ЮРИСДИКЦИИ (РФ)

## 9.1. Провайдерская архитектура

Каждый класс интеграций — интерфейс в ядре, реализации подключаются через `JurisdictionConfig` (ADR-032). Ядро не содержит слов «ЕСИА», «ЕГРЮЛ», «СБП» — только вызовы интерфейсов. Интерфейсы (Python-протоколы):

```python
class IdentityVerificationProvider(Protocol):      # ADR-052
    def start_verification(self, user) -> RedirectFlow: ...
    def complete(self, callback_data) -> VerifiedIdentity: ...   # ФИО, атрибуты, уровень

class EntityRegistryProvider(Protocol):            # ADR-004/044
    def fetch_entity_data(self, tax_id) -> RegistryEntityData: ...
    def director_matches(self, entity, verified_name) -> bool: ...
    def get_director_hash(self, entity) -> str: ...

class PoaRegistryProvider(Protocol):               # МЧД; нотариальные — ручной fallback
    def check_poa_active(self, poa_id) -> PoaStatus: ...

class ESignatureProvider(Protocol):                # Госключ через посредника
    def request_signature(self, version_hash, signatory) -> SignFlow: ...
    def verify(self, signature_ref) -> bool: ...

class PaymentProvider(Protocol):                   # ADR-055/056, минимум 2 партнёра
    def create_direct_payment(self, payment) -> PaymentFlow: ...  # СБП-сплит без комиссии платформы
    def charge_contract_fee(self, fee) -> FeeChargeFlow: ...      # оплата комиссии за заключение
    def create_hold(self, payment) -> HoldFlow: ...               # Р2
    def refund(self, payment) -> RefundFlow: ...
    def parse_webhook(self, request) -> ProviderEvent: ...        # с проверкой подписи

class NpdComplianceProvider(Protocol):             # §6.2
    def check_status(self, inn) -> NpdStatus: ...
    def issue_receipt(self, payment) -> Receipt: ...
    def list_annulments(self, since) -> list[Annulment]: ...

class AccountingDocumentProvider(Protocol):        # ADR-037
    def issue(self, contract, doc_type) -> Document: ...

class TimestampAuthority(Protocol):                # RFC 3161
    def stamp(self, digest) -> TsaToken: ...
```

## 9.2. Реализации РФ (Р1)

| Интерфейс | Провайдер Р1 | Резерв/примечание |
|---|---|---|
| IdentityVerification | **ЕСИА** (подтверждённая учётка) — через эксперимент Минцифры/реестр ФЗ-289; до получения доступа — Госключ-флоу через посредника как юридически значимая идентификация (концепция §10) | Иерархия ADR-052; собственную биометрию не обрабатываем (ФЗ-572) |
| EntityRegistry | **Dadata / Контур.Фокус** (коммерческий API поверх ЕГРЮЛ/ЕГРИП) | Прямое API ФНС — резерв; выбор по SLA и цене на пилоте |
| PoaRegistry | **Реестр МЧД ФНС** | Нотариальные доверенности — ручная проверка оператором (у ФНП нет API) |
| ESignature | **Госключ через посредника** (Диадок API / Астрал; УНЭП базово, УКЭП для B2B) | Интеграция 2–3 недели vs 6–8 мес своей СМЭВ (концепция §8) |
| Payment #1 | **Т-Банк «Мультирасчёты»** (СБП-сплит, удержание на счёте банка) | Целевой рельс прямого платежа — СБП (ADR-056); платформа комиссию с платежа не берёт (ADR-055) |
| Payment #2 | **ЮKassa «Безопасная сделка»** (НКО ЮМани) | Второй партнёр обязателен (§15.5, кейс КИВИ); также — эскроу-контур Р2 (холд до 3 мес) |
| NpdCompliance | **Партнёрский API ФНС для платформ** (бесплатный) + открытый API проверки статуса | Проверка: перед договором платного сегмента и перед **каждой** выплатой |
| AccountingDocument | Р1: генерация актов платформой (PDF + хеш) + чеки НПД через API ФНС | Р2: Диадок/Контур ЭДО |
| TSA | Четыре независимых публичных RFC 3161-TSA (CH/PL/EU-qualified/DE), ADR-135 | Параллельные запросы с nonce, кворум 2 из 4; недобор → чекпойнт `unattested` + алерт |
| Push/SMS/Email | Push-провайдеры (FCM/APNS/RuStore) — основной дублирующий канал юрканала ЛК · SMS-агрегатор с фиксацией статусов (fallback для потребителей) · SMTP-провайдер с webhook о доставке | ADR-057: юрканал = размещение в ЛК + push; статус доставки push/SMS фиксируется |

## 9.3. Правила устойчивости интеграций

- Каждый внешний вызов: таймаут, ретраи с джиттером, circuit breaker, метрика.
- **Деградация без блокировки пользователя**: недоступен реестр ЕГРЮЛ — онбординг откладывает сверку (карточка `pending`), недоступен TSA — метка ставится отложенно (файл уже захеширован), недоступен платёжный партнёр №1 — маршрутизация на №2 (`ProviderRoute`).
- Все вебхуки идемпотентны (`UNIQUE (provider, provider_operation_id)`).
- Санкционированные окна простоя провайдеров учитываются в паузе доменных тайм-аутов, если блокируют действие стороны.

---

# 10. БЕЗОПАСНОСТЬ, ПЕРСОНАЛЬНЫЕ ДАННЫЕ, АУДИТ

## 10.1. Модель угроз (приоритетные)

Подмена документа между подписями (закрыто: подпись на integrity_hash) · редактирование доказательств кем угодно, включая платформу (закрыто: WORM-бакеты, Audit Vault, хеши + TSA) · захват карточки юрлица (закрыто: claim + инертность) · отзыв полномочий задним числом (закрыто: снепшоты) · фрод с доказательствами на устройстве (закрыто: DeviceKey, окно выгрузки, дедуп по хешу, контроль скачков часов) · накрутка репутации (частотный анализ, нет бонусов за имитируемое) · **раскрытие телефонной книги** (закрыто: хранятся только необратимые хеши, сырые номера не принимаются, жёсткий rate-limit на перебор — §5.2.1b, 152-ФЗ) · **подмена личности через @handle** (закрыто: хендл ≠ верифицированная личность; подписант — только верифицированное физлицо/юрлицо) · утечка ПД (шифрование на записи, минимизация: ЕСИА-модель не приносит паспортные данные на платформу).

## 10.2. Crypto-shredding (ADR-035)

- Иерархия ключей: KMS root → KEK на субъекта ПД (user / entity / contract) → DEK на запись. KEK живут только в KMS/Vault, приложение оперирует envelope'ами.
- Запрос на удаление ПД: проверка удерживающих оснований (активные договоры, законные сроки хранения бухдокументов) → уничтожение KEK → `subject_key.destroyed_at` → событие в Audit Vault. Хеши, подписи, суммы, даты, `trust_id` остаются (законный интерес; необратимы и не раскрывают ПД).
- Ротация KEK — ежегодно; DEK не ротируются (данные неизменяемы).
- Восстановление невозможно by design — это фича, зафиксировано в оферте.

## 10.3. Audit Vault (ADR-038)

Отдельный сервис + БД; API: `append(entry)`, `verify_chain(from, to)`, `read(filter)` (только роли операторов платформы (backoffice) по ADR-038). Каждая запись — хеш-цепочка; ежесуточный checkpoint штампуется TSA и выгружается в WORM-бакет. **Метки времени (ADR-135):** корень суточного checkpoint'а (не каждый файл) штампуется по RFC 3161 параллельно у четырёх независимых публичных TSA (`TSA_ENDPOINTS`, кворум `TSA_QUORUM=2`, обязательный nonce, `certReq`); запись checkpoint'а — `{alg, root, leaves, host_id, tsa_status, timestamps[]}`, где каждый слой метки хранит `.tsr` как есть + цепочку сертификатов + OCSP/CRL-ответ на момент штампования (через годы сертификат TSA истечёт — без архивной копии проверка не сойдётся); `alg` — поле (ГОСТ-Стрибог добавляется без миграции формата), `leaves` — содержимое диапазона (пересчёт корня другим алгоритмом), `timestamps` — список (rollover — новые слои поверх старых). Недобор кворума → `tsa_status=unattested`, событие `audit_vault.checkpoint_unattested`, метрика `porukam_audit_vault_checkpoint_attested=0`, алерт. Офлайн-проверка — `verify_checkpoint_timestamps` (+ экспорт пакета под `openssl ts -verify`); проба доступности TSA — `tsa_probe` в cron боевого хоста (services/audit_vault/README.md). Пишутся: все доменные события, каждый просмотр ПД оператором платформы (без обязательной причины), смены статусов оператором (двойное подтверждение — two-person rule в контуре backoffice), выдачи/отзывы полномочий, начисления и оплаты комиссии за заключение.

## 10.4. Соответствие 152-ФЗ и ФЗ-289

Данные — в РФ-облаке; политика обработки ПД и публичные регламенты (споры, рейтинг, санкции) — статические страницы, версионируемые в git с датами вступления; согласия фиксируются с версией документа. Поиск по контактам — только по необратимым хешам, с явным согласием на загрузку и без хранения сырых номеров. Роли `support/compliance/finance/admin` — по ADR-038; доступ служебных ролей к продуктовым данным только через служебное API с логированием (прямой SQL-доступ к prod закрыт, экстренный — по break-glass процедуре с записью в Vault).

## 10.5. Прикладная безопасность

OWASP ASVS L2 как базовая планка · зависимость-скан (pip-audit) и секрет-скан в CI · секреты — в Vault/KMS, не в env-файлах репозитория · загрузки: антивирус, проверка MIME, EXIF-санитайзер для портфолио · pre-signed URL с TTL ≤ 15 мин · pen-test перед запуском и ежегодно.

---

# 11. НЕФУНКЦИОНАЛЬНЫЕ ТРЕБОВАНИЯ

| Категория | Требование |
|---|---|
| Доступность | 99,9% для API (бюджет простоя ~43 мин/мес). Метрики аптайма публикуемы — они основание паузы тайм-аутов (ADR-039) |
| Производительность | p95 < 300 мс для чтения, < 800 мс для доменных операций; приём evidence-пакета 100 МБ < 60 с; дашборды < 500 мс (селекторы + кеш 30 с) |
| Масштаб (горизонт года) | 100 тыс. пользователей, 10 тыс. активных договоров одновременно, ~1 ТБ/мес медиа. PostgreSQL справляется с запасом; узкое место — медиа (масштабируется Evidence Ingest + S3) |
| RPO / RTO | RPO ≤ 5 мин (WAL-архивация), RTO ≤ 1 ч. Ежедневные полные бэкапы + непрерывная архивация; ежеквартальные учения по восстановлению. Audit Vault и S3 — георепликация |
| Наблюдаемость | Метрики (Prometheus): RED по эндпоинтам, лаг очередей, лаг sweep'а дедлайнов (SLO < 60 с), статусы провайдеров; трейсинг (OTel); алёрты на: лаг дедлайнов, рост failed-платежей и failed-начислений комиссии за заключение, недоставку юридически значимых уведомлений (не размещено в ЛК), разрыв цепочки Audit Vault |
| Дедлайны | Sweep каждую минуту; фактическое срабатывание тайм-аута не позже +5 мин от дедлайна; при простое — автоматическая компенсация всех активных дедлайнов на длительность простоя |
| Совместимость клиентов | API обратно совместимо в пределах v1; мобильные клиенты старше 2 минорных версий получают soft-force-update |
| Тестирование | Юнит-тесты сервис-слоя (инварианты FSM — обязательное покрытие каждого перехода и каждого запрета; `compute_segment` — покрытие каждого правила §6.6 и запрета `excluded`), property-based на деньги/дерево этапов/маржинальную шкалу комиссии, контрактные тесты провайдеров (записанные касеты + песочницы), e2e основных путей (договор от черновика до оплаты для free_c2c и paid_business), нагрузочные перед релизом |
| Документация | OpenAPI из кода; ADR-журнал продолжается; runbook'и операций (инцидент платёжного партнёра, восстановление, break-glass) |

---

# 12. ТРЕБОВАНИЯ К МОБИЛЬНОМУ КЛИЕНТУ

> **Стадийность (ревизия 2.0.2, §14 п. 17).** Мобильное приложение остаётся обязательным для полного Р1, но выпускается **второй стадией (Р1-мобайл)**. Первая стадия (Р1-веб) — адаптивный Web SPA + PWA; доказательства этапа в ней принимаются загрузкой через веб с видимой пометкой «без усиленной доказательной защиты» (нет подписи DeviceKey и контроля момента съёмки — только серверные хеш и RFC 3161 при получении). Требования ниже относятся к Р1-мобайл; приложение проектируется **сфокусированным на доказательном контуре** — остальной функционал уже покрыт Web SPA/PWA, дублировать его в нативном клиенте на старте не требуется (достаточно камеры, очереди, назначений и юрзначимых экранов приёмки/подписания либо переходов в PWA).

Мобильное приложение (iOS/Android) — обязательный клиент полного Р1: только оно даёт доказательную съёмку. Ключевые требования (ADR-053, ADR-036, ADR-057):

1. **Встроенная камера** — единственный источник доказательных фото/видео этапа; выбор из галереи для evidence-роли запрещён.
2. **DeviceKey**: генерация пары ключей в Secure Enclave/Keystore при входе; приватный ключ не покидает устройство; подпись манифеста каждого файла.
3. **Обработка на устройстве**: клиентское сжатие → sha256 → упаковка манифеста (время устройства, NTP-скью, геометка, договор/этап/пункт, назначение) → подпись → зашифрованный контейнер приложения (недоступен из галереи).
4. **Офлайн-очередь**: съёмка полностью работоспособна без сети; выгрузка при появлении соединения; индикатор «не выгружено N файлов, окно истекает через T»; после подтверждения сервера — очистка локальных копий.
5. **Юридически значимые экраны**: личный кабинет как основной канал уведомлений (ADR-057) — юридически значимые события всегда видны в ЛК, push дублирует; таймер приёмки с невозможностью не заметить (§44a.2), AI-резюме перед подписью, полная раскладка комиссии за заключение и тарифа оператора до подтверждения операции.
6. Push-уведомления с deep-link в действие; ЛК — юрканал, email/SMS — опциональные дубли (для потребителей fallback-SMS).
7. **Поиск по контактам**: хеширование номеров телефонной книги на устройстве (необратимо, с согласия); сырые номера на сервер не отправляются.

Web SPA покрывает всё, кроме доказательной съёмки (загрузка документов — можно; evidence этапа — только мобильный клиент).

---

# 13. ПЛАН РЕЛИЗОВ

| Релиз | Состав | Критерий готовности |
|---|---|---|
| **Р1 «Полное ядро»** | Всё из §1.3: субъекты (с TrustID/@handle), два профиля, идентичность и граф доверия (поиск по контактам, объединения-витрины), claim, полномочия, полный цикл договора, сегментация C2C (ADR-058), дерево этапов, справочники (включая каталог типов договоров), допники, прямой платёж через платформу (2 партнёра, 0% комиссии платформы), комиссия за заключение деньгами, споры, доказательства с офлайн-режимом, репутация + Insights, портфолио, субподрядные связи, дашборды, комплаенс НПД + счётчик самозанятости, уведомления (ЛК+push), Audit Vault, crypto-shredding. Клиенты — двумя стадиями (ревизия 2.0.2): **Р1-веб** (адаптивный Web SPA + PWA; доказательства — загрузкой с пометкой «без усиленной доказательной защиты») → **Р1-мобайл** (нативное приложение доказательного контура: камера + DeviceKey + офлайн-очередь) | Прохождение e2e «договор → этапы → сдача → спор → скидка-допник → оплата → гарантия → экспорт пакета» для free_c2c и paid_business; юр-приёмка регламентов; нагрузочное тестирование; pen-test. Для стадии Р1-веб e2e проходит с веб-загрузкой доказательств; полный критерий (со съёмкой) — по выходе Р1-мобайл |
| **Р2 «Защита и документы»** | Эскроу-холд (лестница защиты, ЮKassa БС), особые сегменты (недвижимость/транспорт, аренда между физлицами — отдельные договорные модули, П-15), EDI-закрывающие, платное хранение доказательств (фича-флаг → включение), маркетплейс-витрина (Путь В/Г публично), медиация как управляемый процесс | Метрика ADR-056: доля эскроу vs прямых по когортам |
| **Р3 «Интеллект»** | ИИ-ассистент разбивки на этапы и чек-листов (на данных справочника и споров), рекомендации цен/сроков из истории, партнёрское API, якорение TrustID во внешнем распределённом реестре (по решению) | Качество рекомендаций на исторических данных |
| Вне плана | Гарантированная сделка, механики с хранением средств — только при смене юрстатуса (ADR-021); реализация долей/паёв/ценных бумаг (`excluded`) — платформа не готовит | — |

Порядок разработки внутри Р1 (зависимости): `jurisdictions/catalog` → `accounts/identity/social/entities/authority` → `contracts/milestones` → `payments/billing` → `evidence` → `disputes/warranty` → `reputation/profiles/links/dashboards/marketplace` → комплаенс и полировка. Интеграционные треки (ЕСИА-доступ, договоры с платёжными партнёрами, API ФНС) стартуют параллельно с первого дня — у них самый длинный внешний lead time.

---

# 14. ОТКРЫТЫЕ ВОПРОСЫ ДЛЯ ПРОРАБОТКИ В ХОДЕ РАЗРАБОТКИ

1. **Доступ к ЕСИА**: статус заявки в эксперимент Минцифры / реестр платформ ФЗ-289; до получения — Госключ-флоу как строгая идентификация. Блокирует финальный дизайн онбординга (ADR-052).
2. **Наполнение каталога типов договоров (ADR-058, П-15)**: закрытый белый список бесплатного C2C (займы физлиц, купля-продажа/дарение личного имущества, урожай ЛПХ и т.д.), перечень возмездных услуг, состав `special` (недвижимость/транспорт, аренда) и `excluded`. Юрист + внесение в справочник `contract_type_catalog_item`. Блокирует финальный дизайн `compute_segment` §6.6.
3. **Упрощение claim** (ADR-042): проверить гипотезу «claim = выдача первого SigningAuthority» до реализации `entities` — влияет на модель и API §8.2.
4. **Значения тайм-аутов по категориям** (приёмка, окно выгрузки, окна оспаривания) — таблица категорий договоров с юристом; в системе — конфигурация, не код.
5. **Выбор пары платёжных партнёров**: подтвердить тарифы (тариф оператора на получателе), возможность СБП-сплита без комиссии платформы и оплаты комиссии за заключение через того же провайдера — пилотными договорами Т-Банк Мультирасчёты и ЮKassa БС; зафиксировать план миграции.
6. **Маржинальная шкала комиссии за заключение** (ADR-054 rev2): финальные границы диапазонов и ставки (1% → 0.2%), нижний/верхний порог, округление, валюта — наполнение `fee_schedule_tier`. Плательщик комиссии по сегментам.
7. **AI-резюме условий** (§14.3): выбор модели/хостинга с учётом ПД (локальный инференс или обезличивание), формат фиксации факта показа.
8. **Наполнение справочников**: стартовый состав сфер, номенклатуры материалов и шаблонов чек-листов для вертикали «ремонт/строительство» — контентная задача до релиза (ADR-047: раньше ИИ-ассистента).
9. **Пороги систематичности и счётчик самозанятости** (C2C, пара заказчик–исполнитель; порог напоминания о регистрации СМЗ) — после подзаконных актов ФЗ-289 и ADR-058.
10. **Механика объединений (AddressableGroup)**: границы витрины, агрегированная репутация (`aggregate_only`), передача лидерства, взаимодействие хендла группы и подписанта. Открытый вопрос 15 реестра.
11. **Соль и алгоритм хеширования контактов**: единый серверный salt vs пер-пользовательский, устойчивость к перебору при малом пространстве номеров (152-ФЗ).
12. **Формат УНЭП/УКЭП для допников малых сумм** — какой уровень подписи достаточен по категориям сделок (юрист + посредник Госключа).
13. **Тарифная сетка платного хранения** (ADR-036) — до включения фича-флага в Р2.
14. **Обнаруженное расхождение источников**: ADR-009 фиксирует один терминальный статус несостоявшегося соглашения (`NOT_CONCLUDED`), а концепция v9 и доменная модель — два (`rejected_by_counterparty` / `withdrawn_by_initiator`). Спецификация следует концепции v9 и доменной модели; рекомендуется пометить соответствующую часть ADR-009 «Заменено» при следующей редакции журнала.
15. **[Т-решение] `PLATFORM_SPLIT` упразднён как способ расчёта** (ревизия 2.0.1, реестр Р-2). Концепция §15.1 перечисляла «безналичный через платформу (split)» отдельной строкой лестницы защиты, но сплит-перевод — это технический **рельс** доставки денег напрямую исполнителю (концепция §15.2 прямо: «сплит-перевод — технический рельс как для прямого платежа, так и для полной защиты»), а не самостоятельный способ: им пользуются и `direct_platform` (СБП-сплит), и `hold` (сплит при капчере). CHECK-ограничение §5.2.4 (пять способов) — каноническое; доменная модель синхронизирована 23.07.2026. При следующей редакции концепции рекомендуется убрать отдельную строку split из таблицы §15.1.
16. **Зафиксировано исправление доменной модели (реестр Р-1, 23.07.2026): семантика `has_business_status`.** Прежняя редакция метода (`any(available_entities())`) давала бизнес-статус любому активному Representative — представитель чужого юрлица терял бесплатный `free_c2c` для личных услуг. Каноническая семантика (эта спецификация, §5.2.1 и §6.6 п.2): статус даёт только **собственный** СМЗ/ИП (claim по совпадению ИНН — OWNER_IDENTITY_MATCH); представительство и даже директорство чужого юрлица статуса физлицу не дают. Обязательный тест: «представитель чужого ООО + личная возмездная услуга → `free_c2c`».
18. **ADR-059 «Приватность, находимость и видимость профиля» — ФИНАЛИЗИРОВАН 01.08.2026** (журнал ADR ч. 4, раздел J; решения Р1–Р8). Источник реализации для 3.3/3.5-privacy — `claude/Задача_Э3_дельта-3.3_ADR-059-финал.md` (при расхождении с исходной постановкой Э3 §3.3 первична дельта): модель `Consent` на три согласия с версиями текстов; `discoverable_by_phone` NULL до явного выбора; поля видимости `Profile` (`profile_visibility` public/link_and_deals, `hide_from_catalog`, `show_name`, `avatar_visibility`; бизнес-профиль всегда public, пока активен — Р5); удаление несматченных хешей в транзакции сверки (Р8); публичная выдача геолокации — только город + `works_remotely` (Р6). Детальная правка §5.2.1b/§8.1b/§8.11 — при следующей полной ревизии спеки (вместе с синхронизацией под финмодель v2).
17. **Стадийность клиентов Р1 (решение заказчика 23.07.2026, ревизия 2.0.2) — кандидат в ADR-журнал (предлагаемый номер ADR-060; номер 059 занят решением о приватности, см. п. 18).** Р1-веб: адаптивный Web SPA + PWA; доказательства этапа — загрузкой через веб с обязательной видимой пометкой «без усиленной доказательной защиты» (серверные хеш + RFC 3161 при получении есть; подписи DeviceKey и контроля момента съёмки нет — вес оценивают стороны и суд, в духе «информация вместо наказания» и по аналогии с меткой «без защиты платежа»). Р1-мобайл: нативное приложение, сфокусированное на доказательном контуре (встроенная камера, DeviceKey, офлайн-очередь, назначения) — с его выходом для evidence-роли включается запрет галереи и требование встроенной камеры (§12). Требует: формулировки пометки в оферте/регламентах (юрист), решения о судьбе веб-загруженных доказательств после выхода Р1-мобайл (остаются с пометкой), внесения в ADR-журнал при следующей редакции.

---

*Спецификация согласована с концепцией v9.0, доменной моделью v9 (синхронизирована 23.07.2026) и ADR-001…058. Изменения архитектурных решений — только через ADR-журнал; изменения [Т-решений] — через ревизию этого документа.*
