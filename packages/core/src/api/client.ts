/**
 * API-клиент: тонкая fetch-обёртка с конвенциями заголовков (ТЗ §10.3).
 *
 *  - Authorization: Bearer <access>            — из tokenProvider
 *  - X-Acting-Profile: <profile_id>            — контекст актёра, только доменные запросы
 *  - Idempotency-Key: <uuid>                   — небезопасные POX по деньгам/подписям/сдаче
 *  - If-Match / Accept-Language                — оптимистическая блокировка / локаль
 *
 * Ошибки читаются как application/problem+json и оборачиваются в ApiError с
 * доменным `code`. Переключение mock↔real (Ф6) не требует переписывания:
 * меняется только baseUrl/провайдеры.
 */
import { ApiError, type ProblemDetails } from '../errors';
import type { TokenPair } from './types';

export interface ApiClientConfig {
  baseUrl: string;
  /** Access-токен (в памяти на web, secure storage на mobile). */
  getAccessToken?: () => string | null;
  /** Refresh-токен для тихого обновления пары по 401 (отсмотр прода
   * 2026-08-18 №9: access живёт 15 минут — без обновления любая сессия
   * умирала в тупиковый ErrorState). Без геттера поведение прежнее. */
  getRefreshToken?: () => string | null;
  /** Успешное тихое обновление — вызывающая сторона сохраняет новую пару. */
  onTokensRefreshed?: (tokens: TokenPair) => void;
  /** Сессию спасти не удалось (refresh отсутствует/отклонён): вызывающая
   * сторона сбрасывает вход — реактивный гард сам уводит на экран входа. */
  onAuthExpired?: () => void;
  /** Текущий профиль актёра для X-Acting-Profile. */
  getActingProfileId?: () => string | null;
  /** Accept-Language — статичное значение (устарело, оставлено для обратной совместимости
   * тестов); реальный клиент должен передавать `getLocale`, привязанный к активному
   * `i18n.language` (DEV-16b — язык договора на подписании зависит от Accept-Language). */
  locale?: string;
  /** Accept-Language — геттер, читается на КАЖДЫЙ запрос (не на конструктор), тот же
   * приём, что `getAccessToken`/`getActingProfileId`. Приоритетнее `locale`. */
  getLocale?: () => string;
  /** Инъекция fetch (для тестов/SSR). */
  fetchImpl?: typeof fetch;
  /** Генератор UUID (по умолчанию crypto.randomUUID). */
  uuid?: () => string;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  /** `FormData` — multipart (загрузка файла, `evidence`/ADR-088 Фаза 5): НЕ
   * JSON.stringify'ится и Content-Type НЕ проставляется руками — fetch сам
   * ставит `multipart/form-data; boundary=...`, ручной заголовок его сломал бы. */
  body?: unknown;
  /** Значение-массив — повторяемый параметр (`?sphere=a&sphere=b`, план
   * 11.09 §6/ADR-184): каждый элемент своей парой `append`, не CSV — так
   * его ждёт `request.query_params.getlist()` на бэке. */
  query?: Record<string, string | number | undefined | null | string[]>;
  /** true => отправить X-Acting-Profile (доменный запрос). */
  actor?: boolean;
  /** true => сгенерировать Idempotency-Key (деньги/подписи/сдача этапа). */
  idempotent?: boolean;
  ifMatch?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** `'blob'` — бинарный ответ (миниатюра/скачивание evidence, `GET /evidence/{id}/
   * thumbnail|download` — apps.evidence, Django стримит байты через Response, не JSON,
   * ADR-088 Фаза 5). Заголовки/авторизация те же — прямой `<img src>` эти пути не
   * откроет (нет Bearer), только фетч через клиент + `URL.createObjectURL`. */
  responseType?: 'json' | 'blob';
}

export class ApiClient {
  private cfg: Required<Pick<ApiClientConfig, 'baseUrl'>> & ApiClientConfig;
  private fetchImpl: typeof fetch;
  private uuid: () => string;

  constructor(cfg: ApiClientConfig) {
    this.cfg = cfg;
    // Ленивая ссылка на fetch: MSW (тесты/worker) патчит globalThis.fetch ПОСЛЕ
    // создания клиента — нельзя захватывать оригинал через bind на этапе конструктора.
    this.fetchImpl = cfg.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.uuid =
      cfg.uuid ??
      (() =>
        typeof globalThis.crypto?.randomUUID === 'function'
          ? globalThis.crypto.randomUUID()
          : fallbackUuid());
  }

  /** Однополётное обновление пары: параллельные 401 ждут ОДИН запрос refresh. */
  private refreshing: Promise<'refreshed' | 'rejected' | 'unavailable'> | null = null;

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    try {
      return await this.send<T>(path, opts);
    } catch (err) {
      // Тихий refresh — только для доменных запросов: сам контур /auth/*
      // (вход, refresh, logout) отдаёт свои 401 по делу, их не «спасаем».
      const expired = err instanceof ApiError && err.status === 401 && !path.startsWith('/auth/');
      if (!expired || !this.cfg.getRefreshToken) throw err;
      const refreshed = await this.tryRefresh();
      if (refreshed === 'refreshed') return this.send<T>(path, opts);
      if (refreshed === 'rejected') this.cfg.onAuthExpired?.();
      // 'unavailable' — refresh не ДОШЁЛ (сеть/5xx/таймаут холодного бэка,
      // №8 отсмотра): пара может быть жива — разлогинивать нельзя (выброс
      // на /welcome посреди мастера, отсмотр 2026-08-19). Отдаём исходную
      // ошибку — экран покажет её, повторная попытка снова зайдёт в refresh.
      throw err;
    }
  }

  private async tryRefresh(): Promise<'refreshed' | 'rejected' | 'unavailable'> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(attempt = 0): Promise<'refreshed' | 'rejected' | 'unavailable'> {
    const refresh = this.cfg.getRefreshToken?.();
    if (!refresh) return 'rejected';
    try {
      const tokens = await this.send<TokenPair>('/auth/token/refresh', {
        method: 'POST',
        body: { refresh },
      });
      this.cfg.onTokensRefreshed?.(tokens);
      return 'refreshed';
    } catch (err) {
      // Приговор сессии — ТОЛЬКО явный отказ бэка: 401 problem+json с кодом
      // refresh_token_invalid (ADR-108). Остальные 4xx — Cloudflare 403/челлендж,
      // 429, HTML вместо JSON — как и обрыв сети/5xx: недоступность, не logout.
      // ADR-119: 401 на САМ /auth/token/refresh может дать только бэк — это
      // приговор с любым кодом (refresh_token_invalid; authentication_required
      // от старого бэка, аутентифицировавшего протухший Bearer). Cloudflare-
      // челлендж/обрыв — 403/5xx/сеть — остаются «недоступно», не logout.
      const rejected = err instanceof ApiError && err.status === 401;
      if (!rejected) return 'unavailable';
      // ADR-107: refresh ротируется с блэклистом, а вкладки делят один токен.
      // Если пока мы ходили с ним, другая вкладка уже обновила пару (токен в
      // хранилище сменился) — это не «сессия мертва», повторяем с новым. Один раз.
      if (attempt === 0 && this.cfg.getRefreshToken?.() !== refresh) return this.doRefresh(1);
      return 'rejected';
    }
  }

  private async send<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const abs = this.cfg.baseUrl.startsWith('http');
    // Относительный baseUrl (/v1) резолвим против текущего origin — так URL
    // абсолютен и в браузере (fetch/MSW-worker), и в jsdom/node (undici требует абсолют).
    const origin =
      (globalThis as { location?: { origin?: string } }).location?.origin ?? 'http://localhost';
    const url = new URL(this.cfg.baseUrl.replace(/\/$/, '') + path, abs ? undefined : origin);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
          for (const item of v) url.searchParams.append(k, item);
        } else {
          url.searchParams.set(k, String(v));
        }
      }
    }

    const isFormData = typeof FormData !== 'undefined' && opts.body instanceof FormData;

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Accept-Language': this.cfg.getLocale?.() ?? this.cfg.locale ?? 'ru',
      ...opts.headers,
    };
    if (opts.body !== undefined && !isFormData) headers['Content-Type'] = 'application/json';

    // Контур входа/выхода/refresh (`/auth/*`) предъявляет refresh/код в теле,
    // Bearer ему не нужен — а ПРОТУХШИЙ Bearer старый бэк отвергал 401 ещё до
    // AllowAny, и сессия не могла ни обновиться, ни умереть (ADR-119).
    const token = path.startsWith('/auth/') ? null : this.cfg.getAccessToken?.();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    if (opts.actor) {
      const pid = this.cfg.getActingProfileId?.();
      if (pid) headers['X-Acting-Profile'] = pid;
    }
    if (opts.idempotent) headers['Idempotency-Key'] = this.uuid();
    if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;

    const res = await this.fetchImpl(url.toString(), {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : isFormData ? (opts.body as FormData) : JSON.stringify(opts.body),
      signal: opts.signal,
    });

    if (!res.ok) {
      let problem: ProblemDetails = { status: res.status, title: res.statusText };
      try {
        problem = { ...problem, ...(await res.json()) };
      } catch {
        /* тело не JSON — оставляем статус */
      }
      const retryAfter = res.headers.get('Retry-After');
      if (retryAfter && problem.retry_after === undefined) {
        problem.retry_after = Number(retryAfter);
      }
      throw new ApiError(res.status, problem);
    }

    if (res.status === 204) return undefined as T;
    if (opts.responseType === 'blob') return (await res.blob()) as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

function fallbackUuid(): string {
  // Не криптостойкий — только фолбэк для окружений без crypto (тесты в node).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.floor(performance.now() * 1000) + Math.floor(Math.random() * 16)) % 16;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
