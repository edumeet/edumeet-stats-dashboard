import { publicHref, readAuthConfig } from '@/lib/auth/config';
import { BASE_PATH } from '@/lib/basePath';
import { safeReturnTo } from '@/lib/auth/gate';
import { beginLogin } from '@/lib/auth/oidc';
import { messagePage } from '@/lib/auth/page';
import { LOGIN_COOKIE_TTL, cookieNames, createLoginToken, setCookie } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * GET /auth/login[?returnTo=/a/path][&fresh=1]
 *
 * Starts one sign-in: remembers the attempt in a short-lived cookie and sends
 * the browser to the provider. `fresh=1` asks the provider to show its sign-in
 * form even when it still has a session, for "sign in with another account".
 */
export async function GET(request: Request) {
  const auth = readAuthConfig();
  if (auth.mode === 'misconfigured') {
    return messagePage(503, 'Sign-in is not configured', 'The dashboard serves nothing until it is. The server log says which setting is missing.');
  }
  if (auth.mode === 'disabled') return new Response(null, { status: 302, headers: { Location: `${BASE_PATH}/` } });

  const params = new URL(request.url).searchParams;
  const returnTo = safeReturnTo(params.get('returnTo'));

  try {
    const { url, attempt } = await beginLogin(auth, returnTo, { freshLogin: params.get('fresh') === '1' });
    const headers = new Headers({ Location: url.href, 'Cache-Control': 'no-store' });
    headers.append(
      'Set-Cookie',
      setCookie(auth, cookieNames(auth).login, await createLoginToken(auth, attempt), LOGIN_COOKIE_TTL),
    );
    return new Response(null, { status: 302, headers });
  } catch (err) {
    console.error('[auth] the sign-in could not be started:', err instanceof Error ? err.message : err);
    return messagePage(
      502,
      'The sign-in service did not answer',
      'The dashboard could not reach the service that signs you in. Try again in a moment.',
      [{ href: publicHref(auth, '/auth/login'), label: 'Try again' }],
    );
  }
}
