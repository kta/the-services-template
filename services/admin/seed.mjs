// Seed for the admin D1. Idempotent — safe to re-run: INSERT OR IGNORE なので
// 既存行(運用で変更済みのパスワード・plan・無効化状態)は上書きしない。
//
// Creates: the platform-admin org + its admin user (login enabled) and two
// sample organizations (free / contracted) so a fresh environment has
// something to click through. The password hash mirrors
// packages/shared/src/password.ts (client PBKDF2 stretch → server pepper HMAC).
//
// Local:  `pnpm --filter @app/admin db:seed:local`  (wired into `make init`)
// 本番:   `AUTH_PEPPER=<prod-pepper> ADMIN_PASSWORD=<initial-pw> node services/admin/seed.mjs --remote`
//         → PEPPER は本番 `wrangler secret put AUTH_PEPPER` の値と一致させること。
//           seed 行は運用開始後に削除できるよう id を `*-seed` で固定している。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REMOTE = process.argv.includes('--remote')
// pepper は local は dev 値、remote は環境変数(本番 secret と一致)を要求する。
const DEV_PEPPER = 'dev-auth-pepper-change-me' // == .dev.vars(.example) AUTH_PEPPER (local)
const PEPPER = REMOTE ? (process.env.AUTH_PEPPER ?? '') : DEV_PEPPER
if (REMOTE && !PEPPER) {
  console.error('❌ --remote には AUTH_PEPPER 環境変数(本番 secret と同値)が必要です。')
  process.exit(1)
}
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com'
// admin パスワード: local は ADMIN_PASSWORD env 優先、無ければ dev 既定。
// **--remote は環境変数を必須**にし、コミット済みの既知資格情報が本番 admin に
// 入るのを防ぐ。
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? (REMOTE ? '' : 'admin-dev-password-change-me')
if (REMOTE && !ADMIN_PASSWORD) {
  console.error('❌ --remote には ADMIN_PASSWORD 環境変数(本番 admin の初期パスワード)が必要です。')
  process.exit(1)
}
// == packages/shared/src/password.ts の SALT_PREFIX(フォーク時はアプリ固有値に変更)
const SALT_PREFIX = 'app:'
const ITERATIONS = 600_000
const NOW = new Date().toISOString()

const enc = new TextEncoder()
const b64 = (buf) => Buffer.from(new Uint8Array(buf)).toString('base64')

// mirrors stretchPassword(): client-side PBKDF2-HMAC-SHA256, salt = SALT_PREFIX+email
async function stretch(password, email) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: enc.encode(SALT_PREFIX + email.toLowerCase()),
      iterations: ITERATIONS,
    },
    key,
    256,
  )
  return b64(bits)
}
// mirrors hashStretched(): server pepper HMAC → `hmac$<base64>`
async function hashStretched(stretched, pepper) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(stretched))
  return `hmac$${b64(sig)}`
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`

const passwordHash = await hashStretched(await stretch(ADMIN_PASSWORD, ADMIN_EMAIL), PEPPER)

const orgs = [
  // isOperator='1' はプラットフォーム運営 org のみ。管理 API(/api/organizations*)は
  // この org の admin ユーザーだけが使える(テナント admin は 403 operator_only)。
  { id: 'org-admin-seed', name: 'Platform Admin', plan: 'contracted', operator: '1' },
  { id: 'org-sample-free-seed', name: 'Sample Org (free)', plan: 'free', operator: '0' },
  {
    id: 'org-sample-contracted-seed',
    name: 'Sample Org (contracted)',
    plan: 'contracted',
    operator: '0',
  },
]

const lines = [
  ...orgs.map(
    (o) =>
      `INSERT OR IGNORE INTO organizations (id, name, plan, is_disabled, is_operator, created_at) VALUES (${q(o.id)}, ${q(o.name)}, ${q(o.plan)}, '0', ${q(o.operator)}, ${q(NOW)});`,
  ),
  `INSERT OR IGNORE INTO users (id, organization_id, email, password_hash, role, created_at) VALUES ('user-admin-seed', 'org-admin-seed', ${q(ADMIN_EMAIL)}, ${q(passwordHash)}, 'admin', ${q(NOW)});`,
]

const sqlPath = join(mkdtempSync(join(tmpdir(), 'admin-seed-')), 'seed.sql')
writeFileSync(sqlPath, lines.join('\n'))

execFileSync(
  'pnpm',
  [
    'exec',
    'wrangler',
    'd1',
    'execute',
    'admin',
    REMOTE ? '--remote' : '--local',
    '--file',
    sqlPath,
    '--yes',
  ],
  { cwd: import.meta.dirname, stdio: 'inherit' },
)

const where = REMOTE ? 'REMOTE(本番)' : 'local'
console.log(`\n✅ seeded admin D1 [${where}]`)
console.log(`   管理者ログイン: ${ADMIN_EMAIL}${REMOTE ? '' : ` / ${ADMIN_PASSWORD}`}`)
if (REMOTE) {
  console.log('   ※ 本番の初期パスワードは初回ログイン後に必ず変更すること。')
  console.log('   ※ サンプル org をドメイン側にも同期するには admin の日次照合 Cron を実行。')
}
