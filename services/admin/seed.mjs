// Seed for the admin D1. Idempotent — safe to re-run: INSERT OR IGNORE なので
// 既存行(運用で変更済みのパスワード・plan・無効化状態)は上書きしない。
//
// Creates: the platform-admin org + its admin user (login enabled) and two
// sample organizations (free / contracted) so a fresh environment has
// something to click through. The password hash mirrors
// packages/shared/src/password.ts (client PBKDF2 stretch → server pepper HMAC).
//
// Local:  `pnpm --filter @app/admin db:seed:local`  (wired into `make init`)
// 本番:   protected production workflow の guarded step からだけ
//         node seed.mjs --remote --confirm-production=RESTORE_PRODUCTION
//         を実行する。AUTH_PEPPER と ADMIN_PASSWORD は workflow の一時環境へ渡し、
//         Wrangler child process へは渡さない。seed 行は運用開始後に削除できるよう
//         id を `*-seed` で固定している。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { effectiveValues, parseJsonc } from '../../scripts/check-production-config.mjs'
import {
  productionEnvironment,
  productionStaticEnvironment,
} from '../../scripts/production-environment.mjs'
import { resolveProductionPnpm } from '../../scripts/production-pnpm.mjs'
import { runProductionWrangler } from '../../scripts/production-wrangler.mjs'
import {
  validateProductionSeedConfirmation,
  validateRemoteSeedDatabaseId,
  validateRemoteSeedDatabaseInfo,
  validateRemoteSeedInput,
} from '../../scripts/validate-seed-input.mjs'

const seedArgs = process.argv.slice(2)
const REMOTE = seedArgs.includes('--remote')
const PRODUCTION_CONFIRMATION = 'RESTORE_PRODUCTION'
const confirmationArg = seedArgs.find((arg) => arg.startsWith('--confirm-production='))
const expectedConfirmationArg = `--confirm-production=${PRODUCTION_CONFIRMATION}`
if (
  seedArgs.some((arg) => !['--remote', expectedConfirmationArg].includes(arg)) ||
  (confirmationArg && confirmationArg !== expectedConfirmationArg)
) {
  console.error(`usage: seed.mjs [--remote ${expectedConfirmationArg}]`)
  process.exit(2)
}
if (!REMOTE && confirmationArg) {
  console.error('production confirmation is only valid with --remote')
  process.exit(2)
}
if (REMOTE) {
  try {
    validateProductionSeedConfirmation(confirmationArg?.slice('--confirm-production='.length))
  } catch {
    console.error(`--remote requires ${expectedConfirmationArg}`)
    process.exit(2)
  }
}
let childEnv
let pnpm
if (REMOTE) {
  // `node seed.mjs --remote` is a guarded workflow entry point. Keep the
  // reviewed-checkout and protected-workflow guard here so bypassing the
  // package script cannot write to the production D1.
  execFileSync(
    process.execPath,
    [join(import.meta.dirname, '../../scripts/require-production-provisioning.mjs')],
    {
      cwd: import.meta.dirname,
      stdio: 'inherit',
      // No Cloudflare credential is needed to establish the checkout trust
      // boundary. Do not hand a credential-bearing environment to it.
      env: productionStaticEnvironment(process.env),
    },
  )
  childEnv = productionEnvironment(process.env)
  // Bootstrap credentials are used only to derive the seed hash. Never expose
  // them to the Wrangler child process.
  for (const name of ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'AUTH_PEPPER']) delete childEnv[name]
  execFileSync(
    process.execPath,
    [join(import.meta.dirname, '../../scripts/check-production-config.mjs'), 'admin'],
    { cwd: import.meta.dirname, stdio: 'inherit', env: childEnv },
  )
  execFileSync(
    process.execPath,
    [join(import.meta.dirname, '../../scripts/check-production-secrets.mjs'), 'admin'],
    { cwd: import.meta.dirname, stdio: 'inherit', env: childEnv },
  )
} else {
  // A local D1 seed never needs Cloudflare credentials. Keep checkout-local
  // Wrangler from inheriting an operator's production token accidentally.
  childEnv = productionStaticEnvironment(process.env)
  pnpm = resolveProductionPnpm()
}
const adminConfig = parseJsonc(readFileSync(join(import.meta.dirname, 'wrangler.jsonc'), 'utf8'))
const ADMIN_DATABASE = effectiveValues(adminConfig).databaseName?.trim()
const ADMIN_DATABASE_ID = effectiveValues(adminConfig).adminDatabaseId?.trim()
if (!ADMIN_DATABASE || !/^[a-z][a-z0-9_-]{0,62}$/.test(ADMIN_DATABASE)) {
  console.error('configured admin D1 database name is invalid')
  process.exit(1)
}
const REMOTE_DATABASE_ID = REMOTE ? validateRemoteSeedDatabaseId(ADMIN_DATABASE_ID) : undefined
// pepper は local は dev 値、remote は環境変数(本番 secret と一致)を要求する。
const DEV_PEPPER = 'dev-auth-pepper-change-me' // == .dev.vars(.example) AUTH_PEPPER (local)
const PEPPER = REMOTE ? (process.env.AUTH_PEPPER ?? '') : DEV_PEPPER
if (REMOTE && !PEPPER) {
  console.error('❌ --remote には AUTH_PEPPER 環境変数(本番 secret と同値)が必要です。')
  process.exit(1)
}
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL ?? 'admin@example.com').trim().toLowerCase()
// admin パスワード: local は ADMIN_PASSWORD env 優先、無ければ dev 既定。
// **--remote は環境変数を必須**にし、コミット済みの既知資格情報が本番 admin に
// 入るのを防ぐ。
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? (REMOTE ? '' : 'admin-dev-password-change-me')
if (REMOTE) {
  const violations = validateRemoteSeedInput({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    pepper: PEPPER,
  })
  if (violations.length > 0) {
    for (const violation of violations) console.error(`❌ ${violation}`)
    process.exit(1)
  }
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
      `INSERT OR IGNORE INTO organizations (id, name, plan, is_disabled, is_operator, version, created_at) VALUES (${q(o.id)}, ${q(o.name)}, ${q(o.plan)}, '0', ${q(o.operator)}, 1, ${q(NOW)});`,
  ),
  `INSERT OR IGNORE INTO users (id, organization_id, email, password_hash, role, created_at) VALUES ('user-admin-seed', 'org-admin-seed', ${q(ADMIN_EMAIL)}, ${q(passwordHash)}, 'admin', ${q(NOW)});`,
]

const sqlDir = mkdtempSync(join(tmpdir(), 'admin-seed-'))
const sqlPath = join(sqlDir, 'seed.sql')
try {
  writeFileSync(sqlPath, lines.join('\n'), { mode: 0o600 })

  const args = [
    'd1',
    'execute',
    REMOTE ? REMOTE_DATABASE_ID : ADMIN_DATABASE,
    REMOTE ? '--remote' : '--local',
    '--file',
    sqlPath,
    '--yes',
  ]
  if (REMOTE) {
    const databaseInfo = runProductionWrangler(
      ['d1', 'info', ADMIN_DATABASE, '--json'],
      {
        cwd: import.meta.dirname,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
        env: childEnv,
      },
      process.env,
    )
    validateRemoteSeedDatabaseInfo(databaseInfo, ADMIN_DATABASE_ID)
    runProductionWrangler(
      args,
      { cwd: import.meta.dirname, stdio: 'inherit', env: childEnv },
      process.env,
    )
  } else {
    execFileSync(pnpm, ['exec', 'wrangler', ...args], {
      cwd: import.meta.dirname,
      stdio: 'inherit',
      env: childEnv,
    })
  }
} finally {
  // The SQL contains the initial password hash and must not remain in /tmp,
  // including when Wrangler exits unsuccessfully.
  rmSync(sqlDir, { recursive: true, force: true })
}

const where = REMOTE ? 'REMOTE(本番)' : 'local'
console.log(`\n✅ seeded admin D1 [${where}]`)
console.log(`   管理者ログイン: ${ADMIN_EMAIL} (パスワードは入力値)`)
if (REMOTE) {
  console.log('   ※ 本番の初期パスワードは初回ログイン後に必ず変更すること。')
  console.log(
    '   ※ サンプル org をドメイン側にも同期するには admin の hourly reconcile Cron を実行。',
  )
}
