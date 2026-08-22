# 依存関係の管理

この文書は、依存の更新・追加・削除と、pnpm/Knip/Renovateの運用手順の正典である。共有versionの単一ソースはルートの `pnpm-workspace.yaml` catalog、解決結果の正典は `pnpm-lock.yaml` とする。

## 基本方針

- 直接依存は実際にimport・CLI・config・peer APIで必要なworkspaceだけが宣言する。hoistで偶然見えるpackageへ依存しない。
- 複数workspaceで使う外部packageはcatalogへversionを1回だけ置き、manifestでは `catalog:` を使う。
- runtime、dev、peerを役割で分ける。bundle/Worker実行時に必要なら `dependencies`、build/test/typecheckだけなら `devDependencies`、consumerが同じinstanceを供給すべきlibrary APIなら `peerDependencies`。
- 新しい依存は既存標準APIや導入済みtoolで代替できないか確認する。採用時はlicense、maintenance、bundle/runtime cost、Cloudflare Workers対応を調べる。
- pre-releaseを通常更新に使わない。major更新は公式release/migration guideとinstalled type declarationを確認する。
- lockfileだけを手編集しない。manifest/catalog変更後にpin済みpnpmで生成する。

## Toolchain

`mise.toml` がNodeとpnpmをpinし、`package.json#packageManager` も同じpnpm versionを宣言する。

```sh
mise install
pnpm --version
pnpm install --frozen-lockfile
```

miseがない一時環境では、repositoryを変更せず同じversionを実行できる。

```sh
npx -y pnpm@11.22.0 install --frozen-lockfile
```

恒常的な開発環境ではmiseを使い、複数のpinを手動でずらさない。

## 更新手順

### 1. 最新版と影響を調べる

```sh
pnpm outdated -r
pnpm list -r --depth 0
```

major、Cloudflare/Vite/Vitestの連動更新、Zodなど契約推論へ影響する更新は、公式documentationでbreaking changesとpeer rangeを確認する。推測でconfig keyやAPIを置換しない。

### 2. Version sourceを更新する

共有packageは `pnpm-workspace.yaml` catalog、root専用toolはroot `package.json`、単独workspace専用packageはそのmanifestを更新する。pnpm更新時は次を同じ変更に含める。

- `package.json#packageManager`
- `package.json#engines.pnpm`
- `mise.toml`
- pnpm major migrationで変わるworkspace settings
- CI/setup actionがpinを読むことの確認

### 3. Install policyを確認する

pnpm 11は依存build scriptをdefault denyし、24時間のrelease-age gateを持つ。

- `allowBuilds` はnative binary生成など本当に必要なpackageだけ `true` にする。
- `dangerouslyAllowAllBuilds` を使わない。
- 新しすぎるversionを緊急採用する場合、release-age policy全体を無効化せず、監査した正確な `package@version` だけを `minimumReleaseAgeExclude` へ置く。
- pnpmが書いた `set this to true or false` placeholderをcommitしない。

```sh
pnpm install
pnpm install --frozen-lockfile
```

frozen installが通らなければ、manifest/catalogとlockfileの差を確認する。安易に `--no-frozen-lockfile` をCIへ追加しない。

### 4. 未使用・暗黙依存を監査する

```sh
pnpm deps:check
```

Knip findingは次の順で処理する。

1. `rg` でsource、test、config、scriptの実使用を確認する。
2. 未使用ならmanifestから削除する。
3. importしているが未宣言なら、そのworkspaceへ直接追加する。
4. runtime/dev/peer分類が違えば移動する。
5. Worker platformのvirtual module、generated file、外部entryはKnip configで根拠を明示する。

findingを消すだけの広い `ignoreDependencies`、issue type全体の除外、source directory全体のignoreは禁止する。ignoreはgenerated fileやplatform virtual moduleなど解析不能な境界に限定する。

### 5. Migrationと検証

挙動差がある更新は既存contract/integration testを先に実行し、必要なら回帰testを追加してからsourceを直す。

```sh
pnpm deps:check
pnpm check
pnpm build
pnpm run test:traceability
pnpm --filter @app/example_service e2e
pnpm --filter @app/admin e2e
pnpm outdated -r
pnpm install --frozen-lockfile
```

`outdated` に行が残る場合、互換性のため意図的に据え置くversionはPRへ公式根拠と追跡taskを記載する。「testが通るから」だけでは据え置かない。

## Peer conflictの切り分け

1. `pnpm why <package> -r` と `pnpm list -r --depth 0` で要求元を確認する。
2. 最新安定版同士のpeer rangeをregistryとpackage manifestで確認する。
3. 同じecosystemの連動packageをまとめて更新する。
4. source/configを新APIへ移行する。
5. `--force`、恒久的な `strict-peer-dependencies=false`、無根拠なoverrideで隠さない。

upstreamが最新安定版をまだsupportしない場合だけ、互換性のある最新versionを選び、理由、公式issue、解除条件をPRへ残す。

## Renovate

`renovate.json` はnpm/pnpmだけでなく、GitHub Actions、mise、Terraform providerも監視し、次を担う。

- Dependency DashboardとConventional Commit
- 24時間のminimum release age（pnpm側policyと二重化）
- catalogのgroup更新と人間review
- production/peer dependencyとmajor updateの人間review
- greenな非major dev dependencyだけのautomerge
- pnpmの `packageManager` と `mise.toml` pinを同じgroupで提示
- 定期lockfile maintenance（transitive update を含めて automerge せず、人間review）

GitHub Actionsはtagだけでなく、確認済みrelease commit SHAへpinする。Terraform provider更新は
`terraform -chdir=infra/terraform/cloudflare init -backend=false -upgrade` でlockfileを更新し、
`terraform validate` まで実行する。

0.x packageはminorでもbreakingになり得るため、自動merge対象から外す。Renovate PRも通常PRと同じ `pnpm check` を通す。

設定変更時は公式validatorを使う。

```sh
npx --yes --package renovate -- renovate-config-validator --strict
```

## Review checklist

- [ ] 全manifestの追加・削除・分類に実使用の根拠がある
- [ ] catalogと個別manifestに重複version sourceがない
- [ ] pnpmの2つのpinが一致する
- [ ] build-script allowlistとrelease-age例外が最小で説明されている
- [ ] official migration guideに沿うsource/config変更がある
- [ ] Knipに未説明finding・広すぎるignoreがない
- [ ] lockfileはpin済みpnpmで再生成され、frozen installが通る
- [ ] check、traceability、build、必要なe2e、outdated確認が完了している
- [ ] README、AGENTS、service AGENTS、運用文書が実際のcommandと一致する
