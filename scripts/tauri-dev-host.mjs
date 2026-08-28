#!/usr/bin/env node

import { isIP } from 'node:net'

function isPrivateIpv4(value) {
  const octets = value.split('.').map(Number)
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  )
}

function isPrivateIpv6(value) {
  const normalized = value.toLowerCase()
  return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')
}

/**
 * @param {string | null | undefined} value
 * @returns {string | undefined}
 */
export function validateTauriDevHost(value) {
  if (value === undefined || value === null || value.trim() === '') return undefined
  const host = value.trim()
  const ipVersion = isIP(host)
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    (ipVersion === 4 && isPrivateIpv4(host)) ||
    (ipVersion === 6 && isPrivateIpv6(host))
  ) {
    return host
  }
  throw new Error('TAURI_DEV_HOST must be a loopback or private LAN address')
}
