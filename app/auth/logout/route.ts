import { publicHref, readAuthConfig } from '@/lib/auth/config';
import { BASE_PATH } from '@/lib/basePath';
import { endSessionUrl } from '@/lib/auth/oidc';
import { messagePage } from '@/lib/auth/page';
import { cookieNames, setCookie } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * POST /auth/logout
 *
 * Ends the session here and, where the provider offers it, there as well.
 * A POST from this dashboard only, so that a link on another site cannot sign
 * somebody out.
 */
export async function POST(request: Request) {
  const auth = readAuthConfig();
  if (auth.mode !== 'oidc') return new Response(null, { status: 303, headers: { Location: `${BASE_PATH}/` } });

  if (request.headers.get('origin') !== auth.publicUrl.origin) {
    return new Response('Sign out from the dashboard itself.\n', { status: 403 });
  }

  const headers = new Headers({
    Location: (await endSessionUrl(auth)) ?? publicHref(auth, '/auth/logout'),
    'Cache-Control': 'no-store',
  });
  headers.append('Set-Cookie', setCookie(auth, cookieNames(auth).session, '', 0));
  return new Response(null, { status: 303, headers });
}

/** GET /auth/logout: where the browser lands afterwards. Changes nothing. */
export async function GET() {
  const auth = readAuthConfig();
  const links = auth.mode === 'oidc' ? [{ href: publicHref(auth, '/auth/login'), label: 'Sign in again' }] : [];
  return messagePage(200, 'You are signed out', 'The dashboard shows nothing until somebody signs in.', links);
}
