import { SignJWT, jwtVerify } from 'jose';
import { cookiePath, type AuthSettings } from './config.ts';

/**
 * The two cookies of the sign-in, both signed with `AUTH_SECRET`.
 *
 *   session  who is signed in, until it expires. Checked on every request.
 *   login    what one sign-in attempt has to remember between leaving for the
 *            provider and coming back: state, nonce, PKCE verifier, and where
 *            the user wanted to go. Lives ten minutes.
 *
 * Both are signed tokens rather than ids into a server-side store, so the
 * dashboard stays stateless and any number of containers can serve one user.
 * The audience differs, so one kind is never accepted as the other.
 *
 * Works in the middleware as well as in route handlers: `jose` needs only Web
 * Crypto.
 */

const ISSUER = 'edumeet-stats-dashboard';
const SESSION_AUDIENCE = 'session';
const LOGIN_AUDIENCE = 'login';
const LOGIN_TTL = 10 * 60;

export interface Session {
  /** The provider's id of the user. */
  sub: string;
  /** What to show next to "Sign out". */
  name: string;
}

export interface LoginAttempt {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
}

const key = (secret: string): Uint8Array => new TextEncoder().encode(secret);

async function sign(secret: string, audience: string, ttl: number, payload: Record<string, unknown>) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(key(secret));
}

async function verify(secret: string, audience: string, token: string | undefined) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience,
    });
    return payload;
  } catch {
    // Expired, tampered with, or signed with an earlier secret: all the same
    // to the caller, who asks the user to sign in again.
    return null;
  }
}

export function createSessionToken(settings: AuthSettings, session: Session): Promise<string> {
  return sign(settings.secret, SESSION_AUDIENCE, settings.sessionTtl, { sub: session.sub, name: session.name });
}

export async function readSessionToken(secret: string, token: string | undefined): Promise<Session | null> {
  const payload = await verify(secret, SESSION_AUDIENCE, token);
  if (!payload || typeof payload.sub !== 'string' || !payload.sub) return null;
  return { sub: payload.sub, name: typeof payload.name === 'string' ? payload.name : payload.sub };
}

export function createLoginToken(settings: AuthSettings, attempt: LoginAttempt): Promise<string> {
  return sign(settings.secret, LOGIN_AUDIENCE, LOGIN_TTL, { ...attempt });
}

export async function readLoginToken(secret: string, token: string | undefined): Promise<LoginAttempt | null> {
  const payload = await verify(secret, LOGIN_AUDIENCE, token);
  if (!payload) return null;
  const { state, nonce, codeVerifier, returnTo } = payload;
  if (typeof state !== 'string' || typeof nonce !== 'string') return null;
  if (typeof codeVerifier !== 'string' || typeof returnTo !== 'string') return null;
  return { state, nonce, codeVerifier, returnTo };
}

// ── Cookies ─────────────────────────────────────────────────────────────────

/**
 * Cookie names. Over https they carry the `__Secure-` prefix, which makes the
 * browser refuse them from a plain-http response, whatever a network attacker
 * injects.
 */
export function cookieNames(settings: AuthSettings): { session: string; login: string } {
  const prefix = settings.publicUrl.protocol === 'https:' ? '__Secure-' : '';
  return { session: `${prefix}stats_session`, login: `${prefix}stats_login` };
}

/**
 * A `Set-Cookie` value. `maxAge: 0` deletes the cookie.
 *
 * `HttpOnly`, so script on the page cannot read it. `SameSite=Lax`, so it is
 * not sent with requests another site makes, while the return from the
 * provider, a top-level navigation, still carries the login cookie.
 */
export function setCookie(settings: AuthSettings, name: string, value: string, maxAge: number): string {
  const parts = [
    `${name}=${value}`,
    `Path=${cookiePath(settings)}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (settings.publicUrl.protocol === 'https:') parts.push('Secure');
  return parts.join('; ');
}

export const LOGIN_COOKIE_TTL = LOGIN_TTL;

/** One cookie out of a `Cookie` request header. */
export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
