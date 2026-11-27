import type { AccessRule } from './config.ts';

/**
 * Does this user pass the access rule?
 *
 * Signing in proves who somebody is, not that they may read every meeting's
 * diagnostics. The rule names one claim and the values that open the door: a
 * role, a group, or single users.
 *
 *   OIDC_ALLOW_CLAIM=roles   OIDC_ALLOW_VALUES=stats-viewer
 *   OIDC_ALLOW_CLAIM=email   OIDC_ALLOW_VALUES=ann@example.org,bo@example.org
 *
 * The claim is a string or a list of strings. Anything else never matches.
 */
export function claimAt(claims: Record<string, unknown>, path: string): unknown {
  let current: unknown = claims;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function isAllowed(claims: Record<string, unknown>, rule: AccessRule): boolean {
  if (!rule.claim || rule.values.length === 0) return false;

  // An address somebody typed into their own profile proves nothing. Without
  // the provider's word that it was verified, another user could enter an
  // allowed address and walk in.
  if (rule.claim === 'email' && claims.email_verified !== true) return false;

  const found = claimAt(claims, rule.claim);
  const held = Array.isArray(found) ? found : [found];
  return held.some((v) => typeof v === 'string' && v !== '' && rule.values.includes(v));
}
