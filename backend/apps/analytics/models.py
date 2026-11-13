"""Витрины аналитики — docs/tasks/marketing-metrics.md §8.3.

Три витрины, пересчитываемые раз в час; всё остальное считается поверх них.
Приложение НЕ импортирует чужие модели: пересчёт идёт SQL-запросами в
`sql/` по outbox и доменным таблицам — тому же единственному источнику
истины, из которого строятся хроника объекта, уведомления и журнал аудита
(§1 п.4). Границу проверяет import-linter (контракт «analytics ничего не
импортирует из apps.*»).

Почему обычные таблицы, а не MATERIALIZED VIEW: витрине нужны миграции,
тесты через ORM, mypy и наблюдаемость пересчёта (MartRefreshRun). Полный
пересчёт INSERT ... ON CONFLICT DO UPDATE на нынешних объёмах дешевле
REFRESH MATERIALIZED VIEW CONCURRENTLY и не требует unmanaged-моделей.
См. docs/adr/ADR-145-*.md.

Персональных данных здесь нет и быть не может (§1 п.3): только
идентификаторы, коды стран, языки и агрегаты. Это делает аналитический
контур совместимым с уничтожением ключа субъекта — удалять в аналитике
нечего, потому что там нечего удалять.
"""

from __future__ import annotations

from django.db import models


class MartDailyPulse(models.Model):
    """`mart_daily_pulse` (§8.3) — по дням: регистрации, активации,
    подписанные договоры, принятые этапы (явно / авто), новые споры,
    закрытые сделки. Строка на день — здесь живут и НЕАДДИТИВНЫЕ величины
    (уникальные пары, медиана числа листьев), которые нельзя сложить из
    разрезов."""

    day = models.DateField(primary_key=True)

    registrations = models.PositiveIntegerField(default=0)
    activations = models.PositiveIntegerField(default=0)
    contracts_drafted = models.PositiveIntegerField(default=0)
    negotiations_sent = models.PositiveIntegerField(default=0)
    contracts_signed = models.PositiveIntegerField(default=0)
    contracts_closed = models.PositiveIntegerField(default=0)
    contracts_auto_closed = models.PositiveIntegerField(default=0)
    cross_country_signed = models.PositiveIntegerField(default=0)

    milestones_submitted = models.PositiveIntegerField(default=0)
    milestones_accepted_explicit = models.PositiveIntegerField(default=0)
    milestones_accepted_auto = models.PositiveIntegerField(default=0)

    # Вторая ось северной звезды: ширина сети. Неаддитивна по разрезам.
    active_pairs = models.PositiveIntegerField(default=0)
    median_leaves_in_signed = models.DecimalField(
        max_digits=6, decimal_places=2, null=True, blank=True
    )
    avg_leaves_in_signed = models.DecimalField(
        max_digits=6, decimal_places=2, null=True, blank=True
    )

    disputes_opened = models.PositiveIntegerField(default=0)
    disputes_aging = models.PositiveIntegerField(default=0)
    disputes_escalation = models.PositiveIntegerField(default=0)

    legal_notifications = models.PositiveIntegerField(default=0)
    legal_notifications_placed = models.PositiveIntegerField(default=0)
    # §7: «Автоприёмки при недоставленном уведомлении — строго 0». Не метрика,
    # а инцидент: любой случай — персональный разбор.
    auto_accept_with_undelivered = models.PositiveIntegerField(default=0)

    abandoned_drafts = models.PositiveIntegerField(default=0)

    # --- Установки приложения (ADR-171). Считаются из analytics_install_event
    # — собственного слоя приложения, а не из outbox: доменного события
    # «поставил приложение» нет и быть не должно.
    install_prompt_shown = models.PositiveIntegerField(default=0)
    install_clicks = models.PositiveIntegerField(default=0)
    pwa_installs = models.PositiveIntegerField(default=0)
    play_clicks = models.PositiveIntegerField(default=0)
    standalone_opens = models.PositiveIntegerField(default=0)

    # --- Активные пользователи (ADR-171, §5.4). DAU/WAU — уникальные ЛЮДИ,
    # а не действия: пользователь с десятью действиями за день считается один
    # раз, гость не считается вовсе. Неаддитивны по разрезам (как active_pairs
    # и медианы) — поэтому живут здесь, а не в MartDailyPulseSlice: сложить
    # уникальных по странам нельзя.
    active_users_day = models.PositiveIntegerField(default=0)
    active_users_7d = models.PositiveIntegerField(default=0)

    # --- Каталожный поиск с фильтром (ADR-186, часть 7 плана 11.09). Единый
    # источник — analytics_catalog_search_event: только эти два аддитивных
    # счётчика (всего / с хотя бы одним фильтром) живут в дневной витрине,
    # разрез по видам фильтра и их сочетаниям — не аддитивен по дням и
    # читается напрямую из слоя событий (см. selectors.search_filters).
    catalog_searches_total = models.PositiveIntegerField(default=0)
    catalog_searches_filtered = models.PositiveIntegerField(default=0)

    refreshed_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "mart_daily_pulse"
        verbose_name = "витрина: дневной пульс"
        verbose_name_plural = "витрина: дневной пульс"
        ordering = ["-day"]

    def __str__(self) -> str:
        return f"pulse {self.day}"


class MartDailyPulseSlice(models.Model):
    """Тот же день в обязательных разрезах §8.2 — страна, язык, источник
    входа.

    Грань витрины — ПОЛЬЗОВАТЕЛЬ, а не договор, и это не мелочь: у договора
    две стороны и, в кросс-страновой сделке, две разные страны, так что
    «подписанные договоры по странам» без оговорок складывались бы дважды.
    Поэтому здесь только пользовательские счётчики — ровно та воронка по
    странам, которую просит §4.2: регистрация -> первый подписанный договор
    -> первый принятый этап. Договорные величины живут в
    MartContractLifecycle, неаддитивные (пары, медианы) — в MartDailyPulse.

    `source` — источник входа. Сегодня различим только способ входа
    (социальный вход / телефон); «приглашение против самостоятельно» станет
    измеримым, когда появится контур приглашений (см. README приложения)."""

    id = models.BigAutoField(primary_key=True)
    day = models.DateField()
    country = models.CharField(max_length=8)
    locale = models.CharField(max_length=16)
    source = models.CharField(max_length=16)

    registrations = models.PositiveIntegerField(default=0)
    # Активация — ПЕРВЫЙ подписанный договор пользователя (§5.2).
    activations = models.PositiveIntegerField(default=0)
    # Пользователи, подписавшие в этот день хоть что-нибудь (не обязательно первое).
    users_signing = models.PositiveIntegerField(default=0)
    # Третий шаг воронки по странам (§4.2): первый принятый этап.
    first_milestone_accepted = models.PositiveIntegerField(default=0)

    refreshed_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "mart_daily_pulse_slice"
        verbose_name = "витрина: дневной пульс в разрезах"
        verbose_name_plural = "витрина: дневной пульс в разрезах"
        constraints = [
            models.UniqueConstraint(
                fields=["day", "country", "locale", "source"],
                name="mart_daily_pulse_slice_unique",
            ),
        ]
        indexes = [models.Index(fields=["day"])]

    def __str__(self) -> str:
        return f"pulse {self.day} {self.country}/{self.locale}/{self.source}"


class MartContractLifecycle(models.Model):
    """`mart_contract_lifecycle` (§8.3) — по договорам: полный путь от
    черновика до закрытия с временными метками каждого перехода, число
    этапов, число споров, исход, страны обеих сторон, признак кросс-страновой
    сделки.

    Денег здесь нет сознательно (§0): GMV не измерим — платформа не видит
    денег, суммы декларируются сторонами. Деньги остаются разрезом, но не
    осью, и складывать декларации, называя это оборотом, нельзя."""

    contract_id = models.UUIDField(primary_key=True)

    contract_type_code = models.CharField(max_length=64, blank=True, default="")
    deal_type = models.CharField(max_length=8, blank=True, default="")
    segment = models.CharField(max_length=16, blank=True, default="")
    jurisdiction = models.CharField(max_length=8, blank=True, default="")
    contour = models.CharField(max_length=8, blank=True, default="")
    official_language = models.CharField(max_length=16, blank=True, default="")

    drafted_at = models.DateTimeField(null=True, blank=True)
    sent_at = models.DateTimeField(null=True, blank=True)
    frozen_at = models.DateTimeField(null=True, blank=True)
    signed_at = models.DateTimeField(null=True, blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    first_milestone_accepted_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    closed_at = models.DateTimeField(null=True, blank=True)
    auto_closed_at = models.DateTimeField(null=True, blank=True)

    negotiation_status = models.CharField(max_length=32, blank=True, default="")
    execution_status = models.CharField(max_length=32, blank=True, default="")

    customer_country = models.CharField(max_length=8, blank=True, default="")
    contractor_country = models.CharField(max_length=8, blank=True, default="")
    # Язык интерфейса стороны — такой же первоклассный разрез, как страна (§4):
    # страна отвечает на «куда идти дальше», язык — на «что вычитывать
    # носителем следующим», и оба вопроса задаются об одном и том же договоре.
    customer_locale = models.CharField(max_length=16, blank=True, default="")
    contractor_locale = models.CharField(max_length=16, blank=True, default="")
    customer_profile_id = models.UUIDField(null=True, blank=True)
    contractor_profile_id = models.UUIDField(null=True, blank=True)
    # Уникальная для нас метрика (§4.2): работает ли продукт как международная
    # инфраструктура, а не как набор национальных песочниц.
    is_cross_country = models.BooleanField(default=False)
    # Стороны работают на разных языках интерфейса. Тот же смысл, что у
    # кросс-страновых, но про понимание, а не про юрисдикцию: растущая доля —
    # довод вычитывать переводы, а не расширять их список.
    is_cross_language = models.BooleanField(default=False)
    pair_key = models.CharField(max_length=80, blank=True, default="")

    leaves = models.PositiveIntegerField(default=0)
    milestones_submitted = models.PositiveIntegerField(default=0)
    milestones_accepted_explicit = models.PositiveIntegerField(default=0)
    milestones_accepted_auto = models.PositiveIntegerField(default=0)
    amendments = models.PositiveIntegerField(default=0)
    disputes = models.PositiveIntegerField(default=0)
    disputes_resolved = models.PositiveIntegerField(default=0)
    disputes_cap_reached = models.PositiveIntegerField(default=0)
    disputes_escalated_to_court = models.PositiveIntegerField(default=0)

    # §6: нет доказательств — нет защиты. Сдача «с полным комплектом» — та,
    # где у каждого пункта чек-листа с непустым required_evidence есть хотя бы
    # одно доказательство.
    submitted_leaves = models.PositiveIntegerField(default=0)
    submitted_leaves_full_evidence = models.PositiveIntegerField(default=0)
    # §6: качество справочника = качество всей спорной механики. Связи
    # ChecklistItem -> ChecklistTemplateItem в схеме нет, сопоставление
    # текстовое (см. sql/mart_contract_lifecycle.sql).
    leaves_with_checklist = models.PositiveIntegerField(default=0)
    leaves_checklist_all_from_catalog = models.PositiveIntegerField(default=0)

    # §5.2, отвал на пороге подписания.
    signature_requests = models.PositiveIntegerField(default=0)
    signature_requests_forwarded = models.PositiveIntegerField(default=0)
    signature_requests_declined = models.PositiveIntegerField(default=0)
    signature_requests_expired = models.PositiveIntegerField(default=0)

    # §6: односторонняя отметка «оплатил» без подтверждения получения —
    # ранний детектор проблем и будущих споров.
    leaves_marked_paid = models.PositiveIntegerField(default=0)
    leaves_confirmed_both_sides = models.PositiveIntegerField(default=0)

    refreshed_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "mart_contract_lifecycle"
        verbose_name = "витрина: жизненный цикл договора"
        verbose_name_plural = "витрина: жизненный цикл договоров"
        indexes = [
            models.Index(fields=["signed_at"]),
            models.Index(fields=["drafted_at"]),
            models.Index(fields=["pair_key", "signed_at"]),
        ]

    def __str__(self) -> str:
        return f"lifecycle {self.contract_id}"


class MartUserCohort(models.Model):
    """`mart_user_cohorts` (§8.3) — по пользователям: неделя регистрации,
    страна, язык, источник, дата первого подписанного договора, число
    договоров, дата последней активности.

    Активность — участие в живом договоре, а не логин (§5.4): топики
    `account.*` в расчёт последней активности не входят."""

    user_id = models.UUIDField(primary_key=True)

    cohort_week = models.DateField()
    registered_at = models.DateTimeField()
    country = models.CharField(max_length=8, blank=True, default="")
    # Откуда взялась страна. `GLOBAL` в User.country_code — НЕ страна:
    # apps.accounts проставляет его автоматически при входе через Google
    # («стартовое значение, пользователь может сменить потом»), то есть это
    # ровно «страна не выбрана». Считать его страной — рисовать на карте
    # продукта фантом; на проде 31.08 таких было 5 из 9 аккаунтов. Поэтому
    # `country` для них пуст, а различие живёт здесь и отвечает на вопрос,
    # в какой ветке онбординга дыра.
    country_source = models.CharField(max_length=16, blank=True, default="")
    locale = models.CharField(max_length=16, blank=True, default="")
    contour = models.CharField(max_length=8, blank=True, default="")
    source = models.CharField(max_length=16, blank=True, default="")

    first_contract_signed_at = models.DateTimeField(null=True, blank=True)
    # «Пришёл в конкретную сделку» (§5.1 — основной сценарий входа): момент,
    # когда человек стал стороной договора, который создал НЕ он. Это две
    # метки времени, то есть факт, а не прокси; атрибуции «кто позвал» здесь
    # нет и не подразумевается — сущности приглашения в домене не существует.
    first_foreign_party_at = models.DateTimeField(null=True, blank=True)
    second_contract_signed_at = models.DateTimeField(null=True, blank=True)
    contracts_signed = models.PositiveIntegerField(default=0)
    first_contract_disputed = models.BooleanField(default=False)
    last_activity_at = models.DateTimeField(null=True, blank=True)

    # Активные профили M1/M3/M6 (§5.4): БЫЛА ЛИ активность в соответствующем
    # месяце жизни аккаунта, а не «последняя активность попала в этот месяц».
    # Разница существенна: вернувшийся на третий месяц пользователь остаётся
    # активным и в первом. По last_activity_at этот вопрос не восстановить —
    # поэтому признаки считаются при пересчёте витрины, а не на чтении.
    active_m1 = models.BooleanField(default=False)
    active_m3 = models.BooleanField(default=False)
    active_m6 = models.BooleanField(default=False)

    refreshed_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "mart_user_cohorts"
        verbose_name = "витрина: когорта пользователя"
        verbose_name_plural = "витрина: когорты пользователей"
        indexes = [
            models.Index(fields=["cohort_week"]),
            models.Index(fields=["country"]),
            models.Index(fields=["locale"]),
        ]

    def __str__(self) -> str:
        return f"cohort {self.cohort_week} {self.user_id}"


class MartRefreshRun(models.Model):
    """Наблюдаемость пересчёта: витрина, которая молча перестала
    пересчитываться, хуже отсутствующей — по ней принимают решения, считая
    её свежей. Возраст последнего успешного прогона отдаётся в
    `/internal/v1/metrics/health`."""

    id = models.BigAutoField(primary_key=True)
    mart = models.CharField(max_length=64)
    ok = models.BooleanField()
    rows = models.PositiveIntegerField(default=0)
    duration_ms = models.PositiveIntegerField(default=0)
    error = models.TextField(blank=True, default="")
    started_at = models.DateTimeField()
    finished_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "mart_refresh_run"
        verbose_name = "прогон пересчёта витрины"
        verbose_name_plural = "прогоны пересчёта витрин"
        ordering = ["-finished_at"]
        indexes = [models.Index(fields=["mart", "-finished_at"])]

    def __str__(self) -> str:
        return f"{self.mart} {'ok' if self.ok else 'fail'} {self.finished_at}"


class ConstructorStepEvent(models.Model):
    """Единственный слой поведенческих событий во всём продукте (§8.1):
    шаги конструктора договора. Заведён потому, что брошенный черновик иначе
    неизмерим — доменного события «бросил на шаге 3» не существует и не
    должно существовать.

    Ограничения слоя, они же условия его существования:
    * только экран конструктора — никакого общего клиентского трекинга;
    * без персональных данных: идентификатор черновика, код шага, действие;
    * хранение 90 дней (`purge_constructor_step_events`), дальше — удаление.

    Это НЕ вторая правда о сделке: юридические факты по-прежнему только в
    outbox. Событие конструктора ничего не утверждает о договоре — оно
    утверждает о форме."""

    class Action(models.TextChoices):
        ENTERED = "entered", "Открыл шаг"
        COMPLETED = "completed", "Прошёл шаг"
        LEFT = "left", "Ушёл с шага"

    id = models.BigAutoField(primary_key=True)
    contract_id = models.UUIDField(null=True, blank=True)
    step_code = models.CharField(max_length=64)
    action = models.CharField(max_length=16, choices=Action.choices)
    occurred_at = models.DateTimeField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "analytics_constructor_step_event"
        verbose_name = "событие шага конструктора"
        verbose_name_plural = "события шагов конструктора"
        indexes = [
            models.Index(fields=["contract_id", "occurred_at"]),
            models.Index(fields=["occurred_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.step_code}:{self.action}"


class InstallEvent(models.Model):
    """ВТОРОЙ ввод аналитики (ADR-171): установка приложения с нашего сайта.

    Заведён потому, что установка иначе неизмерима вовсе. Play Console
    показывает только то, что произошло УЖЕ в магазине, а PWA-установка не
    оставляет в домене ни одного следа: `beforeinstallprompt`/`appinstalled`
    живут в браузере и никуда не уходят. Доменного события «поставил
    приложение» не существует и не должно существовать — приложение не
    утверждает ничего о сделке.

    Границы слоя ровно те же, что у `ConstructorStepEvent` (§8.1), и это
    условие его существования, а не оговорка:
    * набор видов ЗАКРЫТ (`Kind`) — произвольное событие принять нельзя;
    * платформа — грубая корзина из UA (android/ios/desktop/other); сам
      User-Agent НЕ хранится: строка UA идентифицирует устройство точнее,
      чем нужно ответу на вопрос «сколько установок»;
    * ни IP, ни отпечатка устройства, ни идентификатора сессии;
    * `user_id` пуст у гостя — установить приложение можно до входа, и это
      нормальный сценарий: посадочная страница открыта, аккаунта ещё нет.
      Для авторизованного он заполняется, потому что без него установка не
      складывается с остальной жизнью аккаунта (DAU, §5.4);
    * хранение 90 дней (`purge_install_events`), дальше — удаление.

    Append-only: событие фиксирует момент, а не состояние. Строку установки
    незачем менять — можно только записать следующую."""

    class Kind(models.TextChoices):
        PROMPT_SHOWN = "install_prompt_shown", "Показали предложение установки"
        CLICK = "install_click", "Нажали «Установить»"
        PWA_INSTALLED = "pwa_installed", "Браузер сообщил об установке"
        PLAY_CLICK = "play_click", "Переход в Google Play"
        STANDALONE_OPEN = "standalone_open", "Открытие в режиме приложения"

    class Platform(models.TextChoices):
        ANDROID = "android", "Android"
        IOS = "ios", "iOS"
        DESKTOP = "desktop", "Десктоп"
        OTHER = "other", "Прочее"

    class DisplayMode(models.TextChoices):
        BROWSER = "browser", "Вкладка браузера"
        STANDALONE = "standalone", "Отдельное окно приложения"

    class Source(models.TextChoices):
        SITE = "site", "Сайт (PWA)"
        PLAY = "play", "Google Play"
        UNKNOWN = "unknown", "Не определён"

    id = models.BigAutoField(primary_key=True)
    # Пусто у гостя — см. докстринг. Не ForeignKey: аналитика ничего не
    # импортирует из apps.* (контракт import-linter, ADR-145), поэтому связь
    # выражена идентификатором, как в MartUserCohort.
    user_id = models.UUIDField(null=True, blank=True)
    kind = models.CharField(max_length=32, choices=Kind.choices)
    platform = models.CharField(max_length=16, choices=Platform.choices, default=Platform.OTHER)
    display_mode = models.CharField(
        max_length=16, choices=DisplayMode.choices, default=DisplayMode.BROWSER
    )
    source = models.CharField(max_length=16, choices=Source.choices, default=Source.UNKNOWN)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "analytics_install_event"
        verbose_name = "событие установки приложения"
        verbose_name_plural = "события установки приложения"
        indexes = [
            models.Index(fields=["created_at"]),
            models.Index(fields=["kind", "created_at"]),
            # DAU/WAU (ADR-171): выборка «кто был активен в этот день»
            # ходит по паре (день, пользователь), а гости в неё не входят.
            models.Index(fields=["user_id", "created_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.kind}:{self.platform}"


class CatalogSearchEvent(models.Model):
    """ТРЕТИЙ и последний ввод приложения (ADR-186, часть 7 плана 11.09):
    факт каталожного поиска исполнителей (`GET /v1/dashboard/search`,
    ветка `catalog`, ADR-184). Единственный вопрос, на который заведён этот
    слой, — окупилась ли работа над фильтрами (часть 5): пользуются ли ими
    вообще и какими именно.

    В отличие от двух предыдущих вводов, запись НЕ приходит POST-ом от
    браузера: факт распознаёт сам бэкенд (`apps.dashboards`) в момент, когда
    вычисляет ветку `catalog`, и передаёт его сюда обычным вызовом фасада
    `apps.analytics.services.record_catalog_search` — тем самым способом,
    которым приложения вообще общаются друг с другом (CLAUDE.md: фасады
    services.py), а не нарушением правила «аналитика — читатель» (ADR-145):
    то правило запрещает АНАЛИТИКЕ импортировать чужое, а не чужим —
    писать в неё через её собственный интерфейс.

    Ограничения слоя — те же, что у двух предыдущих, и это условие его
    существования, а не оговорка:
    * НИКАКИХ персональных данных и никаких идентификаторов человека —
      ни `user_id`, ни IP, ни значений фильтра (кода страны, id города,
      кода сферы). Только КОДЫ УРОВНЕЙ применённого фильтра и агрегаты;
    * пагинация одного и того же поиска (запрос с `cursor`) новой записи не
      создаёт — иначе перелистывание страниц каталога накручивало бы счётчик
      поисков, которых на самом деле не было;
    * короткое окно дедупликации по (пользователь, сочетание фильтра) —
      защита от случайного двойного вызова (двойной клик, повторный рендер),
      а не от целенаправленной накрутки, для которой поиск и так живёт за
      логином (`IsAuthenticated` на `GET /dashboard/search`);
    * хранение 90 дней (`purge_catalog_search_events`), дальше — удаление.

    Append-only: строка фиксирует один факт поиска, менять в ней нечего."""

    class GeoLevel(models.TextChoices):
        NONE = "none", "Без гео-фильтра"
        COUNTRY = "country", "Страна"
        REGION = "region", "Регион"
        CITY = "city", "Город"

    id = models.BigAutoField(primary_key=True)
    # Самый глубокий из запрошенных уровней (ADR-184: «побеждает самый
    # глубокий, более мелкие уровни игнорируются молча») — ровно то, что
    # определяет фактическое поведение фильтра, а не сырые параметры запроса.
    geo_level = models.CharField(max_length=16, choices=GeoLevel.choices, default=GeoLevel.NONE)
    has_sphere = models.BooleanField(default=False)
    has_experience = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "analytics_catalog_search_event"
        verbose_name = "событие каталожного поиска"
        verbose_name_plural = "события каталожного поиска"
        indexes = [
            models.Index(fields=["created_at"]),
            # Разрез по сочетанию фильтров (селектор search_filters) —
            # групповой подсчёт по этой же тройке колонок.
            models.Index(fields=["geo_level", "has_sphere", "has_experience", "created_at"]),
        ]

    def __str__(self) -> str:
        return f"search:{self.geo_level}:sphere={self.has_sphere}:exp={self.has_experience}"
