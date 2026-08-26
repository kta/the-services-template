import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const androidRoot = join(root, 'services/admin/src-tauri/gen/android')
const configPath = join(root, 'services/admin/src-tauri/tauri.conf.json')
const config = JSON.parse(await readFile(configPath, 'utf8'))
const androidPackage = config.identifier.replaceAll('.', '/')
if (!/^[a-zA-Z][a-zA-Z0-9_.]+$/.test(config.identifier)) {
  throw new Error(`Invalid Android package identifier: ${config.identifier}`)
}
const mainSource = join(androidRoot, `app/src/main/java/${androidPackage}/MainActivity.kt`)
const bridgeTarget = join(androidRoot, 'app/src/main/java/io/crates/keyring/Keyring.kt')
const bridgeSource = join(root, 'services/admin/src-tauri/android-template/Keyring.kt')

const original = await readFile(mainSource, 'utf8').catch(() => null)
if (original === null) {
  throw new Error(`Tauri Android MainActivity is missing: ${mainSource}`)
}

const expected = 'class MainActivity : TauriActivity()'
const replacement = `import android.os.Bundle
import io.crates.keyring.Keyring

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Must happen before Tauri loads Rust commands. The protected-store crate
    // otherwise panics when it asks ndk-context for the Android Context.
    Keyring.initializeNdkContext(applicationContext)
    super.onCreate(savedInstanceState)
  }
}`

if (!original.includes(expected)) {
  throw new Error('Unexpected generated MainActivity format; refusing to patch Android lifecycle')
}

await mkdir(dirname(bridgeTarget), { recursive: true })
await cp(bridgeSource, bridgeTarget)
if (original.includes('Keyring.initializeNdkContext(applicationContext)')) {
  process.exit(0)
}
await writeFile(mainSource, original.replace(expected, replacement))
