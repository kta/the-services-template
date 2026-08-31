/**
 * Names which must never cross a credentialless build/artifact boundary.
 * Values are intentionally not stored here: the scanners only need to reject
 * the variable/key names and PEM headers that identify a leaked credential.
 */
export const FORBIDDEN_SECRET_MARKERS = Object.freeze([
  'JWT_SECRET',
  'JWT_PRIVATE_KEY',
  'JWT_PUBLIC_KEY',
  'AUTH_DEV_PRIVATE_KEY',
  'AUTH_DEV_GRANT',
  'AUTH_PEPPER',
  'DOMAIN_TO_ADMIN_KEY',
  'ADMIN_TO_EXAMPLE_SERVICE_KEY',
  'ADMIN_TO_NOTIFIER_KEY',
  'DOMAIN_TO_NOTIFIER_KEY',
  'OPS_TO_NOTIFIER_KEY',
  'INTERNAL_KEY',
  'D1_EXPORT_API_TOKEN',
  'R2_POLICY_CHECK_API_TOKEN',
  'RESEND_API_KEY',
  'BACKUP_SIGNING_PRIVATE_KEY',
  'BACKUP_SIGNING_PUBLIC_KEY',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  '-----BEGIN ' + 'PRIVATE KEY-----',
  '-----BEGIN ENCRYPTED ' + 'PRIVATE KEY-----',
  '-----BEGIN RSA ' + 'PRIVATE KEY-----',
  '-----BEGIN EC ' + 'PRIVATE KEY-----',
  '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----',
])

// A Worker bundle legitimately contains binding identifiers such as
// `JWT_PRIVATE_KEY` because the runtime reads them from `env`. Those names are
// not credentials. The Worker-artifact scanner uses this narrower set plus
// literal-value checks instead of the source/Tauri scanner above.
const FORBIDDEN_ARTIFACT_VALUE_MARKERS = Object.freeze([
  'dev-auth-pepper-change-me',
  'admin-dev-password-change-me',
  'dev-domain-to-admin-key-000000000000',
  'dev-admin-to-domain-key-000000000000',
  'dev-admin-to-example-service-key-000000000000',
  'dev-admin-to-notifier-key-000000000000',
  'dev-domain-to-notifier-key-000000000000',
  'dev-ops-to-notifier-key-000000000000',
  'dev-d1-export-token',
  'dev-r2-policy-check-token',
  'dev-account-id',
])

const FORBIDDEN_SECRET_NAME_PATTERN =
  /\b(?:PRODUCTION_)?(?:JWT_(?:SECRET|PRIVATE_KEY|PUBLIC_KEY)|AUTH_(?:DEV_PRIVATE_KEY|DEV_GRANT|PEPPER)|(?:ADMIN|DOMAIN|OPS)_TO_[A-Z0-9_]+_KEY|INTERNAL_KEY|(?:RESEND|D1_EXPORT|R2_POLICY_CHECK|BACKUP_SIGNING)_[A-Z0-9_]+|CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID))\b/g

export function forbiddenSecretMarkersInText(text) {
  if (typeof text !== 'string') return []
  const markers = new Set(FORBIDDEN_SECRET_MARKERS.filter((marker) => text.includes(marker)))
  FORBIDDEN_SECRET_NAME_PATTERN.lastIndex = 0
  for (const match of text.matchAll(FORBIDDEN_SECRET_NAME_PATTERN)) markers.add(match[0])
  return [...markers]
}

const INLINED_SECRET_LITERAL_PATTERN =
  /\b((?:PRODUCTION_)?(?:JWT_(?:SECRET|PRIVATE_KEY|PUBLIC_KEY)|AUTH_(?:DEV_PRIVATE_KEY|DEV_GRANT|PEPPER)|(?:ADMIN|DOMAIN|OPS)_TO_[A-Z0-9_]+_KEY|INTERNAL_KEY|(?:RESEND|D1_EXPORT|R2_POLICY_CHECK|BACKUP_SIGNING)_[A-Z0-9_]+|CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)))\s*[:=]\s*(["'])([^"']{1,4096})\2/g

function isRuntimeBindingReference(name, value) {
  return new RegExp(
    `^(?:${name}|(?:env|process\\.env|c\\.env|ctx\\.env|bindings)\\.${name})$`,
  ).test(value)
}

/**
 * Check a built Worker output for credential material without rejecting the
 * binding names that the runtime must contain. Values are never included in
 * the returned diagnostics.
 */
export function forbiddenWorkerArtifactMarkersInText(text) {
  if (typeof text !== 'string') return []
  const markers = new Set(
    FORBIDDEN_ARTIFACT_VALUE_MARKERS.filter((marker) => text.includes(marker)),
  )
  for (const marker of [
    '-----BEGIN ' + 'PRIVATE KEY-----',
    '-----BEGIN RSA ' + 'PRIVATE KEY-----',
  ]) {
    if (text.includes(marker)) markers.add(marker)
  }
  INLINED_SECRET_LITERAL_PATTERN.lastIndex = 0
  for (const match of text.matchAll(INLINED_SECRET_LITERAL_PATTERN)) {
    const name = match[1]
    const value = match[3]
    if (!isRuntimeBindingReference(name, value) && value !== name) markers.add(name)
  }
  return [...markers]
}
