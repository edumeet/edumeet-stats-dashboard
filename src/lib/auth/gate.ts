import type { AuthConfig } from './config.ts';

/**
 * What happens to one request. The whole access decision is this function, so
 * it can be read, and tested, in one place.
 *
 * The list of open paths is short on purpose and says what is open, not what is
 * closed: a route added later is behind the sign-in without anybody having to
 * remember it.
 */
export type GateDecision =
  /** Serve it. */
  | 'allow'
  /** A page, and nobody is signed in: send the browser to the sign-in. */
  | 'login'
  /** An API call, and nobody is signed in: 401, no redirect to follow. */
  | 'unauthenticated'
  /** The sign-in is not configured: 503 for everything. */
  | 'unavailable';

/** Paths that answer without a session. `pathname` is without the sub-path. */
export function isOpenPath(pathname: string): boolean {
  return (
    // The sign-in itself. Each of these checks what it needs on its own.
    pathname === '/auth/login' ||
    pathname === '/auth/callback' ||
    pathname === '/auth/logout' ||
    // The container's healthcheck. Says "ok" or not and nothing else to a
    // caller without a session.
    pathname === '/api/health'
  );
}

export const isApiPath = (pathname: string): boolean => pathname === '/api' || pathname.startsWith('/api/');

export function gate(pathname: string, mode: AuthConfig['mode'], signedIn: boolean): GateDecision {
  if (mode === 'disabled') return 'allow';
  if (isOpenPath(pathname)) return 'allow';
  if (mode === 'misconfigured') return 'unavailable';
  if (signedIn) return 'allow';
  return isApiPath(pathname) ? 'unauthenticated' : 'login';
}

/**
 * Where to send the user after signing in: a path on this dashboard, or `/`.
 *
 * The value travels through the browser, so somebody else may have written it.
 * Only a plain path is accepted. `//host`, `/\host` and anything with a scheme
 * would send a freshly signed-in user to another site.
 */
export function safeReturnTo(raw: string | null | undefined): string {
  if (!raw || raw.length > 2000) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  // Control characters and backslashes are never part of a path here, and
  // browsers disagree about what they mean.
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return '/';
  if (raw === '/auth' || raw.startsWith('/auth/') || isApiPath(raw.split(/[?#]/)[0])) return '/';
  return raw;
}
