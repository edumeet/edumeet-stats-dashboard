import { publicHref, readAuthConfig } from '@/lib/auth/config';
import { finishLogin } from '@/lib/auth/oidc';
import { messagePage } from '@/lib/auth/page';
import { isAllowed } from '@/lib/auth/rule';
import {
  cookieNames,
  createSessionToken,
  readCookie,
  readLoginToken,
  setCookie,
} from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * GET /auth/callback?code=...&state=...
 *
 * The browser comes back from the provider. The answer is checked against what
 * the login cookie remembers of the attempt, the code is exchanged, and the
 * user is let in only when the access rule says so.
 */
export async function GET(request: Request) {
  const auth = readAuthConfig();
  if (auth.mode !== 'oidc') {
    return messagePage(503, 'Sign-in is not configured', 'The dashboard serves nothing until it is.');
  }

  const names = cookieNames(auth);
  const tryAgain = { href: publicHref(auth, '/auth/login'), label: 'Try again' };
  // The attempt is over whatever happens next: its cookie goes with every answer.
  const forgetAttempt = { 'Set-Cookie': setCookie(auth, names.login, '', 0) };

  const attempt = await readLoginToken(auth.secret, readCookie(request.headers.get('cookie'), names.login));
  if (!attempt) {
    return messagePage(
      400,
      'The sign-in was not completed',
      'It took longer than ten minutes, or it was started in another window. Start again.',
      [tryAgain],
      forgetAttempt,
    );
  }

  let claims: Record<string, unknown>;
  try {
    claims = await finishLogin(auth, new URL(request.url).search, attempt);
  } catch (err) {
    // The reason stays in the log. What the provider or the address bar says
    // about an error is not text to show on a page.
    console.warn('[auth] sign-in refused:', err instanceof Error ? err.message : err);
    return messagePage(400, 'The sign-in was not completed', 'The answer of the sign-in service was not accepted. Start again.', [tryAgain], forgetAttempt);
  }

  const sub = text(claims.sub);
  const name = text(claims.name) || text(claims.preferred_username) || text(claims.email) || sub;

  if (!sub || !isAllowed(claims, auth.oidc.rule)) {
    console.warn('[auth] signed in but not allowed: %s', name || '(no name)');
    return messagePage(
      403,
      'This account may not open the dashboard',
      `You are signed in as ${name || 'an account without a name'}. The dashboard shows the diagnostics of every meeting, so it is open only to the accounts its operator has named.`,
      [{ href: publicHref(auth, '/auth/login?fresh=1'), label: 'Sign in with another account' }],
      forgetAttempt,
    );
  }

  console.info('[auth] signed in: %s', name);

  const headers = new Headers({
    Location: publicHref(auth, attempt.returnTo),
    'Cache-Control': 'no-store',
  });
  headers.append('Set-Cookie', setCookie(auth, names.session, await createSessionToken(auth, { sub, name }), auth.sessionTtl));
  headers.append('Set-Cookie', forgetAttempt['Set-Cookie']);
  return new Response(null, { status: 302, headers });
}
