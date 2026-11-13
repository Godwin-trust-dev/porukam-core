# Якоря доверия TSA (ADR-147)

Закреплённые корневые сертификаты, закрывающие архивную цепочку метки времени
по совпадению subject + SubjectPublicKeyInfo (побайтно) — без проверки
самоподписи корня. Читает их `tsa._trust_anchor_identities()`; формат — DER
(`*.der`) или PEM (`*.pem`), имена файлов произвольные.

Пиновка нового якоря — осознанное действие в PR: сертификат берётся из
достоверного источника (репозиторий УЦ, CCADB), его подлинность подтверждается
криптографически (например, `openssl verify -partial_chain -CAfile <якорь>`
на живом промежуточном сертификате TSA), отпечаток SHA-256 фиксируется в этой
таблице и сверяется на ревью.

| Файл | Subject | Откуда | Дата пиновки | SHA-256 |
|---|---|---|---|---|
| `certum-trusted-network-ca.der` | C=PL, O=Unizeto Technologies S.A., OU=Certum Certification Authority, CN=Certum Trusted Network CA | AIA caIssuers `http://repository.certum.pl/ctnca.cer` из живого ответа `time.certum.pl` 2026-08-31; подлинность: `openssl verify -partial_chain` на `chain-3` того же ответа → OK (`docs/tasks/Задача_fix_audit-vault-sha1-root.md` §2.6) | 2026-09-02 | `5C:58:46:8D:55:F5:8E:49:7E:74:39:82:D2:B5:00:10:B6:D1:65:37:4A:CF:83:A7:D4:A3:2D:B7:68:C4:40:8E` |
