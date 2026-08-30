const FIXTURE_SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/

export function validateFixtureSecret(name: string, value: string): string {
  if (!FIXTURE_SECRET_PATTERN.test(value)) {
    throw new Error(`${name} must contain only shell-safe fixture characters (32-128 bytes)`)
  }
  return value
}

export function fixtureSecret(
  name: string,
  environment: Record<string, string | undefined>,
): string {
  const existing = environment[name]
  if (existing !== undefined) return validateFixtureSecret(name, existing)
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const generated = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  environment[name] = generated
  return generated
}
