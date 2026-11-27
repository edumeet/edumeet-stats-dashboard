import { NextResponse, type NextRequest } from 'next/server';
import { publicHref, readAuthConfig } from '@/lib/auth/config';
import { gate } from '@/lib/auth/gate';
import { cookieNames, readSessionToken } from '@/lib/auth/session';

/**
 * Nothing is served without a session.
 *
 * This runs before every page and every API route, so a route added later is
 * closed without anybody having to think of it. What is open is listed in
 * `isOpenPath` (src/lib/auth/gate.ts): the sign-in itself and the healthcheck.
 *
 * Only the build's own static files are left out below. They are the same for
 * everybody and hold no meeting data, and the sign-in pages could not load
 * without them.
 */
export const config = {
  matcher: ['/((?!_next/static/).*)'],
};

let reported = false;

export async function middleware(request: NextRequest) {
  const auth = readAuthConfig();
  const { pathname, search } = request.nextUrl;

  if (!reported) {
    reported = true;
    if (auth.mode === 'disabled') {
      console.warn('[auth] AUTH_DISABLED=true: the dashboard is open to everybody who can reach it.');
    } else if (auth.mode === 'misconfigured') {
      console.error('[auth] sign-in is not configured, every request is refused: %s', auth.problems.join('; '));
    } else {
      console.info(
        '[auth] sign-in with %s, client %s, allowed: %s in %s',
        auth.oidc.issuer.href,
        auth.oidc.clientId,
        auth.oidc.rule.values.join(', '),
        auth.oidc.rule.claim,
      );
    }
  }

  let signedIn = false;
  if (auth.mode === 'oidc') {
    const token = request.cookies.get(cookieNames(auth).session)?.value;
    signedIn = (await readSessionToken(auth.secret, token)) !== null;
  }

  switch (gate(pathname, auth.mode, signedIn)) {
    case 'allow':
      return NextResponse.next();

    case 'unauthenticated':
      return NextResponse.json(
        { success: false, error: 'Sign in first.' },
        { status: 401, headers: { 'Cache-Control': 'no-store' } },
      );

    case 'login': {
      if (auth.mode !== 'oidc') break;
      // Built from the configured address, not from the request: behind a
      // proxy the request names an internal host.
      const login = new URL(publicHref(auth, '/auth/login'));
      login.searchParams.set('returnTo', `${pathname}${search}`);
      return NextResponse.redirect(login, { headers: { 'Cache-Control': 'no-store' } });
    }

    case 'unavailable':
      break;
  }

  return new NextResponse(
    'Sign-in is not configured, so the dashboard serves nothing. The server log says which setting is missing.\n',
    { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } },
  );
}
