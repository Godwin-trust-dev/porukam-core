# §E-смоук полного цикла (реальный стек, через UI)

Воспроизводимый драйвер прогона из `docs/tasks/smoke-e2e-full-cycle-report.md`:
два аккаунта, весь путь через UI против локального боевого стека —
создать (мастер) → подписать → этап с фото → приёмка → репутация.

## Подготовка стенда (однократно)

```bash
docker compose -f infra/compose/docker-compose.local.yml up -d
cd backend && uv run manage.py migrate && uv run manage.py migrate --database=audit
# бакеты MinIO (иначе health s3:down и падение загрузки фото):
#   evidence-ru-originals, audit-vault-checkpoints, porukam-dev
uv run manage.py runserver 0.0.0.0:8000 &          # бэкенд
uv run celery -A config worker -B -l warning &      # relay outbox → репутация
cd ../web && VITE_API_MODE=real npm run build       # real-сборка SPA (моки выключены)
node ../scripts/smoke/serve.mjs &                   # статика dist + прокси /v1 → :8000
```

## Прогон

```bash
node scripts/smoke/phaseE.mjs            # из корня репо
RUN_ID=42 node scripts/smoke/phaseE.mjs  # свежие номера/хендлы (OTP-троттлинг по номеру!)
```

Успех — `SMOKE OK` в конце; скриншоты шагов — `scripts/smoke/shots/` (в git не попадают).
Переменные: `WEB_DIST`, `BACKEND` (serve.mjs), `SMOKE_SHOTS`, `SMOKE_PHOTO`, `RUN_ID` (phaseE).

## Что скрипт делает НЕ через UI (осознанно, это сетап, не §E)

- хендл + шаг приватности двух аккаунтов — по API (OTP-пользователи минуют GLOBAL-онбординг),
  с ожиданием АСИНХРОННОЙ материализации Profile (outbox → apps.profiles.subscriber);
- переход на страницу этапа — клиентский pushState+popstate (до PR #110 UI-пути не было;
  можно заменить на клики по «Открыть приёмку»/«Открыть этап»);
- ремаунт списка сделок циклом — обходит staleTime 30с у контрагента.

Ограничение Ф1: authStore в памяти — никаких перезагрузок страницы внутри сессии аккаунта.
