/**
 * latest.json の署名処理。署名対象は signature フィールドを除いた
 * canonical JSON で、R2 の manifest と復旧オペレーターの検証結果を同じ
 * バイト列に固定する。private key は ops Worker にだけ置き、復旧側には
 * 対応する public key だけを配布する。
 */

export const BACKUP_SIGNATURE_ALGORITHM = 'RSASSA-PKCS1-v1_5-SHA256' as const

function canonicalJsonValue(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error('manifest contains an unsupported value')
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJsonValue).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJsonValue(entry)}`)
  return `{${entries.join(',')}}`
}

export function canonicalJson(value: unknown): string {
  return canonicalJsonValue(value)
}

function pemToDer(pem: string, label: 'PRIVATE KEY' | 'PUBLIC KEY'): Uint8Array {
  const match = pem
    .trim()
    .match(new RegExp(`^-----BEGIN ${label}-----([A-Za-z0-9+/\\r\\n=]+)-----END ${label}-----$`))
  if (!match) throw new Error(`backup signing ${label.toLowerCase()} PEM is invalid`)
  const encoded = match[1]
  if (!encoded) throw new Error(`backup signing ${label.toLowerCase()} PEM is invalid`)
  const binary = atob(encoded.replace(/\s+/g, ''))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function base64Url(bytes: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export async function signBackupManifest(
  manifest: unknown,
  privateKeyPem: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(privateKeyPem, 'PRIVATE KEY'),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(canonicalJson(manifest)),
  )
  return base64Url(signature)
}

export async function verifyBackupManifest(
  manifest: unknown,
  signature: string,
  publicKeyPem: string,
): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]+$/.test(signature)) return false
  const key = await crypto.subtle.importKey(
    'spki',
    pemToDer(publicKeyPem, 'PUBLIC KEY'),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const normalized = signature.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    bytes,
    new TextEncoder().encode(canonicalJson(manifest)),
  )
}
