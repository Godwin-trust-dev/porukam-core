# services/audit_vault

ОТДЕЛЬНЫЙ сервис + ОТДЕЛЬНАЯ БД (append-only, цепочка хешей, ADR-038).
Односторонний API: запись + верификация цепочки. Подключается к `postgres_audit`
(port 5433 в infra/compose/docker-compose.local.yml), не к основной БД.

## Суточный чекпойнт и метки доверенного времени (ADR-135)

Раз в сутки (`tasks.daily_checkpoint`) корень цепочки (`this_hash` последней
записи) штампуется по RFC 3161 **параллельно у четырёх независимых публичных
TSA** с кворумом 2 из 4 и обязательным nonce, и выгружается в WORM-объект
вместе с содержимым диапазона (листьями).

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `AUDIT_VAULT_TSA_PROVIDER` | `fake` | `rfc3161` — реальные TSA (прод ОБЯЗАН); `fake` — dev/test |
| `TSA_ENDPOINTS` | 4 TSA из ADR-135 (swisssign, certum, sectigo/qualified, freetsa) | список через запятую |
| `TSA_QUORUM` | `2` | меньше успешных — чекпойнт `unattested` + алерт |
| `TSA_TIMEOUT` | `10` | секунд на запрос к одному TSA |
| `HOST_ID` | пусто (warning) | осмысленный идентификатор боевого хоста в записи чекпойнта, не hostname |

Модули: `tsa.py` — RFC 3161 (TimeStampReq/Resp, офлайн-проверка токена,
цепочка сертификатов по AIA, OCSP/CRL) на `cryptography` + собственный
минимальный DER (`der.py`); `providers.py` — `Rfc3161TimestampAuthority`
(потоки, кворум) и `FakeTimestampAuthority`; `checkpoint.py` — запись
чекпойнта и `verify_checkpoint_timestamps()`.

### Формат записи чекпойнта (WORM-объект `checkpoints/<from>-<to>.json`)

```json
{"format": "porukam.audit_checkpoint/2",
 "alg": "sha256", "root": "<hex>", "seq_from": 1, "seq_to": 120,
 "host_id": "prod-kz-1", "created_at": "...",
 "leaves": {"kind": "audit_entry_chain",
            "entries": [{"seq": 1, "canonical": "<canonical JSON>", "this_hash": "<hex>"}]},
 "tsa_status": "attested",
 "timestamps": [{"tsa": "http://tsa.swisssign.net", "alg": "sha256", "nonce": "0x…",
                 "tsq_b64": "…", "tsr_b64": "…", "gen_time": "...", "serial": "0x…",
                 "policy": "2.16.756.1.89.1.1.3.5", "signer": "CN=…",
                 "chain_pem": ["-----BEGIN CERTIFICATE-----…"], "chain_complete": true,
                 "revocation": {"kind": "ocsp", "url": "…", "der_b64": "…", "status": "good",
                                "produced_at": "...", "this_update": "...", "next_update": "..."},
                 "requested_at": "...", "latency_ms": 250, "warnings": []}],
 "tsa_failures": [{"tsa": "https://freetsa.org/tsr", "error": "timeout: …"}]}
```

- `alg` — поле, не константа (ГОСТ/Стрибог добавляется без миграции формата);
  `leaves` позволяют пересчитать корень другим алгоритмом.
- `timestamps` — список слоёв: rollover (перештамповка через годы) дописывает
  новые слои, старые не трогаются.
- `revocation`: OCSP по AIA сертификата подписанта (нужен сертификат издателя,
  докачивается по AIA caIssuers); иначе CRL по CDP; иначе `null` + warning в
  логе и в `warnings` записи — через годы статус отзыва будет не восстановить.
- `tsa_status`: `attested` (≥ кворума), `unattested` (недобор — лог-событие
  `audit_vault.checkpoint_unattested` уровня error, метрика
  `porukam_audit_vault_checkpoint_attested = 0`, алерт
  `PorukamAuditVaultCheckpointUnattested`), `fake` (dev/test).
- В БД (`audit_checkpoint`) — те же поля, кроме `leaves` (листья лежат там же
  как `audit_entry`).

### Проверка меток (офлайн, без сети)

```bash
python manage.py verify_checkpoint_timestamps            # последний чекпойнт
python manage.py verify_checkpoint_timestamps --id 42 --export-dir /tmp/cp42
```

Проверяется: статус granted, messageImprint = корень, nonce, сертификат
подписанта из **архивной** `chain_pem` (EKU timeStamping, genTime внутри срока
действия), ESSCertID, подпись SignerInfo, звенья цепочки до доверенного корня —
закреплённого якоря (`trust_anchors/`, ADR-147; совпадение по subject + SPKI,
самоподпись корня не проверяется — SHA-1-корни вроде Certum 2008 закрываются
именно так) либо, пока корень не запинован, самоподписанного с современным
алгоритмом. Доверие к незапинованным корням не оценивается — это вопрос
экспертизы.

`--export-dir` кладёт на каждую метку `NN-<host>.tsq` (запрос, как был
отправлен), `NN-<host>.tsr`, `NN-<host>.chain.pem`, `NN-<host>.ocsp.der|crl.der`
и `checkpoint.txt` с корнем и готовыми командами. Независимая проверка
стандартным OpenSSL (пакет юристу/эксперту):

```bash
openssl ts -reply -in 00-tsa.swisssign.net.tsr -text          # прочитать метку
openssl ts -verify -queryfile 00-tsa.swisssign.net.tsq \
    -in 00-tsa.swisssign.net.tsr \
    -CAfile 00-tsa.swisssign.net.chain.pem -untrusted 00-tsa.swisssign.net.chain.pem
# или без запроса, по корню чекпойнта:
openssl ts -verify -digest <root hex> -in 00-tsa.swisssign.net.tsr -CAfile 00-tsa.swisssign.net.chain.pem
openssl ocsp -respin 00-tsa.swisssign.net.ocsp.der -text -noverify   # статус отзыва на момент штампования
```

### Проба доступности TSA (cron на боевом хосте)

```bash
python manage.py tsa_probe [--endpoint URL ...] [--timeout 10] [--no-egress]
```

Одна JSON-строка на endpoint (latency, статус, подписант) + строка `egress`
(внешний IP/страна через https://ifconfig.co/json — прогон с VPN/другой машины
невалиден, ADR-135 «Важно о методике») + `summary` с кворумом. Пример строки
cron — прод-конфиг «Обслуживание».

### Тесты

Сеть в тестах запрещена: `tests/fake_tsa.py` — фейковый TSA с тестовым ЦС,
выдающий настоящий TimeStampResp (принимается и нашим верификатором, и
`openssl ts -verify`); `tests/fixtures/*.tsr` — реальные ответы четырёх TSA
из ADR-135 на запрос `porukam-fixture.tsq` (получены 2026-08-26).
