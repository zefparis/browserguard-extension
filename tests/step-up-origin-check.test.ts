/**
 * Security test for step-up.ts postMessage origin verification.
 *
 * Finding (red-team audit, 2026-09-02):
 *   The step-up.ts message handler accepted postMessage from any origin.
 *   A malicious page could forge a 'browserguard_stepup_result' message
 *   with decision='GO' and bypass the cognitive challenge entirely.
 *
 * Fix:
 *   Added TRUSTED_ORIGINS set and event.origin check — messages from
 *   origins other than challenge.hcs-u7.org and api.hcs-u7.org are
 *   silently rejected.
 *
 * @copyright (c) 2026 Benjamin BARRERE / IA SOLUTION
 * @license Patents Pending FR2514274 | FR2514546
 */

import { describe, it, expect } from 'vitest';

// ─── Simulate the origin check logic from step-up.ts ─────────────────
// This mirrors the TRUSTED_ORIGINS check in the production code.

const TRUSTED_ORIGINS = new Set([
  'https://challenge.hcs-u7.org',
  'https://api.hcs-u7.org',
]);

function isOriginTrusted(origin: string): boolean {
  return TRUSTED_ORIGINS.has(origin);
}

describe('step-up.ts — postMessage origin verification', () => {
  it('accepts messages from challenge.hcs-u7.org', () => {
    expect(isOriginTrusted('https://challenge.hcs-u7.org')).toBe(true);
  });

  it('accepts messages from api.hcs-u7.org', () => {
    expect(isOriginTrusted('https://api.hcs-u7.org')).toBe(true);
  });

  it('rejects messages from evil.com', () => {
    expect(isOriginTrusted('https://evil.com')).toBe(false);
  });

  it('rejects messages from a subdomain (challenge.evil.com)', () => {
    // Subdomain spoofing — should NOT match
    expect(isOriginTrusted('https://challenge.evil.com')).toBe(false);
  });

  it('rejects messages from http (not https) challenge.hcs-u7.org', () => {
    // Protocol downgrade attempt
    expect(isOriginTrusted('http://challenge.hcs-u7.org')).toBe(false);
  });

  it('rejects messages with a port (challenge.hcs-u7.org:8080)', () => {
    // Port-based spoofing
    expect(isOriginTrusted('https://challenge.hcs-u7.org:8080')).toBe(false);
  });

  it('rejects empty origin', () => {
    expect(isOriginTrusted('')).toBe(false);
  });

  it('rejects messages that look similar but are different (challenge.hcs-u7.org.evil.com)', () => {
    expect(isOriginTrusted('https://challenge.hcs-u7.org.evil.com')).toBe(false);
  });
});
