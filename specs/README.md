# specs/ — マルチサービス仕様

サービス（ドメイン）ごとにディレクトリを切る。各サービスは **サービス仕様**（`00_service-spec.md`）と、機能ごとの **feature 仕様**（`features/<NNN>-<slug>/spec.md` — 1 ファイル）を持つ。

```
specs/
├── _service-template/         # 新サービス追加時にコピーする雛形
│   ├── 00_service-spec.md
│   └── features/
├── <service>/                 # 例: example_service, admin
│   ├── 00_service-spec.md      # サービス境界・エンティティ・API面・所有データ
│   └── features/
│       └── <NNN>-<slug>/        # 機能単位（= ブランチ名）
│           └── spec.md          # WHAT → HOW → TASKS を 1 枚で
├── shared/                    # 横断（認証・解析・UI 等）
└── infra/                     # インフラ（Terraform / Wrangler / デプロイ）
```

## サービスの追加手順
1. `cp -r specs/_service-template specs/<service>` してサービス仕様を書く（**Specify 先行**）。
2. `00_service-spec.md` でサービス境界・エンティティ・API 面・所有データ（1 サービス = 1 D1）を定義。
3. 機能ごとに `features/<NNN>-<slug>/spec.md` を [`.specify/templates/feature-template.md`](../.specify/templates/feature-template.md) から起こす。
4. 実装は `services/<service>`（`services/example_service` をコピー）+ `packages/contracts/src/<service>.ts` + Terraform に D1 追加。手順の詳細は `.agents/skills/new-service`。

## 規約
- feature ディレクトリ名 = git ブランチ名（`<NNN>-<slug>` / `feature-*` / `fix-*`）。
- ID 体系: User Story `US-<TAG>-NN` / 受け入れ基準 `AC-<TAG>-NN` / タスク `T-NNN`。
- 曖昧箇所は `[要確認: ...]`。解消まで実装に進まない（`docs/constitution/SDD_CONSTITUTION.md`）。
- いつ spec が要るか・書き方 → `docs/spec-workflow/SPEC_WORKFLOW.md`。

現行サービス: [`example_service`](./example_service/) / [`admin`](./admin/) / 横断 [`shared`](./shared/) / [`infra`](./infra/)
