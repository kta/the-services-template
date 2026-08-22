# notifier エージェント指示

このファイルはルート `AGENTS.md` を継承し、notifier固有の配信保証とsecret境界を追加する。

## 役割と非目標

notifierは内部限定の同期通知Workerである。`POST /api/internal/send` を受け、KV `DEDUPE` とResend idempotency keyで24時間のbest-effort重複抑止を行う。Queue、永続outbox、exactly-once deliveryは提供しない。送信手段未設定時はfail closeして502へつながる失敗を返し、成功を偽装しない。

## 構成と入口

| 場所 | 責務 |
|---|---|
| `src/index.ts` | Hono内部API、internal auth、dedupe、HTTP status |
| `src/senders.ts` | job formatting、Resend sender、明示的dev log sender |
| `test/notifier.integration.test.ts` | API、KV、sender failure |
| `test/dedupe.time.test.ts` | TTLと時刻境界 |
| `test/senders.test.ts` | message formatting、from、idempotency header |
| `wrangler.jsonc` | DEDUPE KVと非secret MAIL_FROM |
| `vitest.config.ts` | workerd test bindingsとcoverage gate |

## 非交渉ルール

- endpointは `x-internal-key` を `INTERNAL_KEY` と照合する。未設定、誤値、外部呼び出しをfail closeする。
- request bodyは `packages/contracts` の `NotificationJob` を `zValidator` で検証する。独自の手書きpayload typeを作らない。
- `RESEND_API_KEY` と `INTERNAL_KEY` はsecretであり、vars、log、response、fixtureへ実値を書かない。
- `MAIL_DEV_LOG=true` は明示的なdev動作だけに使う。本番でsender未設定をLogSenderへ暗黙fallbackしない。
- dedupe keyはjob IDから決定し、TTL 24時間を維持する。KV failure時は送信を試みるbest-effort設計であり、exactly-onceと表現しない。
- Resendへの送信には同じidempotency keyを渡す。非2xxを成功扱いしない。
- KV記録のタイミング、送信失敗時のkey有無、同一job再送の挙動を変更する場合は通知設計の承認を得る。
- email本文やlogへtoken/payload全体を不用意に出さない。招待URLなど既存仕様で必要な値だけをformatする。
- Queueを追加しない。導入はルート規約どおり人間承認が必要なarchitecture変更。

## コマンド

```sh
pnpm --filter @app/notifier dev
pnpm --filter @app/notifier build
pnpm --filter @app/notifier typecheck
pnpm --filter @app/notifier test
pnpm --filter @app/notifier cf-typegen
```

notifierはSPA、D1、Playwright e2eを持たない。存在しないdb/e2e commandを追加前提にしない。

## 必須テスト

- auth/validation: internal keyなし・誤値、invalid body、unknown notification typeをintegrationで検証する。
- sender: 2xx、非2xx、MAIL_FROM default/override、idempotency header、全notification typeの非空subject/bodyを検証する。
- dedupe: TTL直前・ちょうど・直後、重複、KV get/put failure、sender failure後の状態を固定時刻または明示bindingで検証する。
- fallback: best-effortで握りつぶすKV障害は、送信試行、log/response、dedupe keyの有無までassertする。
- contract追加: `packages/contracts/src/notification.ts` を先に更新し、全type表へケースを追加する。

## 文書と完了

配信保証、TTL、sender、secret、binding、statusが変われば `docs/howto/notifications.md`、CODEMAP、deploy checklistを同時更新する。package commandやlocal bindingが変わればこのファイルも更新する。

完了前にnotifier test/typecheck/build、生成型、ルート `pnpm check` をgreenにする。実Resend APIへの送信とdeployは外部操作なので必ず直前承認を得る。
