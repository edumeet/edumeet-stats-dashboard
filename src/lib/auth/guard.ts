import { readAuthConfig, type AuthConfig } from './config.ts';
import { cookieNames, readCookie, readSessionToken, type Session } from './session.ts';

/**
 * The second check, inside each API route.
 *
 * The middleware already refuses a request without a session, for every path.
 * This repeats the check where the storage calls are made, so that the data
 * does not depend on one layer alone: a matcher that misses a path, or a
 * middleware that is skipped, would otherwise open the bucket.
 *
 * Every handler under `app/api/` is wrapped in `guarded()`. A test fails when
 * one is not (scripts/auth.test.ts).
 */

export interface Caller {
  config: AuthConfig;
  /** `null` when nobody is signed in, and when the sign-in is switched off. */
  session: Session | null;
}

export async function callerOf(request: Request): Promise<Caller> {
  const config = readAuthConfig();
  if (config.mode !== 'oidc') return { config, session: null };
  const token = readCookie(request.headers.get('cookie'), cookieNames(config).session);
  return { config, session: await readSessionToken(config.secret, token) };
}

/** May this caller read what the dashboard has? */
export const mayRead = ({ config, session }: Caller): boolean =>
  config.mode === 'disabled' || (config.mode === 'oidc' && session !== null);

const json = (status: number, error: string): Response =>
  new Response(JSON.stringify({ success: false, error }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/** Wrap a route handler so that it runs for a signed-in caller only. */
export function guarded<Context>(
  handler: (request: Request, context: Context) => Promise<Response>,
): (request: Request, context: Context) => Promise<Response> {
  return async (request, context) => {
    const caller = await callerOf(request);
    if (caller.config.mode === 'misconfigured') return json(503, 'Sign-in is not configured.');
    if (!mayRead(caller)) return json(401, 'Sign in first.');

    const response = await handler(request, context);
    // What a signed-in user reads must not be kept by a shared cache and
    // handed to the next person.
    if (!response.headers.has('Cache-Control')) response.headers.set('Cache-Control', 'private, no-store');
    return response;
  };
}
