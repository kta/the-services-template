export function validateProductionSeedConfirmation(value) {
  if (value !== 'RESTORE_PRODUCTION') {
    throw new Error('RESTORE_PRODUCTION confirmation is required')
  }
  return true
}

const DATABASE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function validateRemoteSeedDatabaseId(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
  if (!DATABASE_ID_PATTERN.test(normalized)) {
    throw new Error('remote seed requires a reviewed database id')
  }
  return normalized
}

export function validateRemoteSeedDatabaseInfo(source, expectedId) {
  let value
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error('remote seed database info is invalid JSON')
  }
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : null
  const result = record?.result && typeof record.result === 'object' ? record.result : null
  const actualId = String(record?.database_id ?? result?.database_id ?? '')
    .trim()
    .toLowerCase()
  const expected = validateRemoteSeedDatabaseId(expectedId)
  if (actualId !== expected) {
    throw new Error('remote seed database name does not resolve to the reviewed database id')
  }
  return true
}

export function validateRemoteSeedInput({ email, password, pepper }) {
  const violations = []
  const emailBytes = email ? new TextEncoder().encode(email).length : 0
  if (
    !email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.toLowerCase() === 'admin@example.com'
  ) {
    violations.push('ADMIN_EMAIL must be an explicit non-template email')
  }
  if (emailBytes > 320) violations.push('ADMIN_EMAIL must be at most 320 UTF-8 bytes')
  if (!password || password.length < 12) {
    violations.push('ADMIN_PASSWORD must be at least 12 characters')
  }
  if (password === 'admin-dev-password-change-me') {
    violations.push('ADMIN_PASSWORD must not be a published development/template password')
  }
  if (/^(?:dev|e2e|test)(?:[-_]|$)/i.test(password ?? '')) {
    violations.push('ADMIN_PASSWORD must not be a published development/test value')
  }
  if (
    [...(password ?? '')].some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || code === 0x7f
    })
  ) {
    violations.push('ADMIN_PASSWORD must not contain control characters')
  }
  if (!pepper || new TextEncoder().encode(pepper).length < 32) {
    violations.push('AUTH_PEPPER must be at least 32 UTF-8 bytes')
  }
  if (pepper === 'dev-auth-pepper-change-me') {
    violations.push('AUTH_PEPPER must not be a published development/template value')
  }
  if (/^(?:dev|e2e|test)(?:[-_]|$)/i.test(pepper ?? '')) {
    violations.push('AUTH_PEPPER must not be a published development/test value')
  }
  if (
    [...(pepper ?? '')].some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || code === 0x7f
    })
  ) {
    violations.push('AUTH_PEPPER must not contain control characters')
  }
  return violations
}
