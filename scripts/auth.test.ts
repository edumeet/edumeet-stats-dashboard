/**
 * Who gets in, and what a request without a session gets.
 *
 *   node --experimental-strip-types scripts/auth.test.ts
 *
 * The dashboard holds every meeting's diagnostics, so the checks here are
 * about the ways an installation ends up open without anybody deciding that:
 * settings that are missing, a route that was added and not closed, a cookie of
 * one kind accepted as another, a rule that matches more than it says.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import { cookiePath, publicHref, readAuthConfig, type AuthSettings } from '../src/lib/auth/config.ts';
import { gate, isOpenPath, safeReturnTo } from '../src/lib/auth/gate.ts';
import { guarded } from '../src/lib/auth/guard.ts';
import { claimAt, isAllowed } from '../src/lib/auth/rule.ts';
import {
  cookieNames,
  createLoginToken,
  createSessionToken,
  readCookie,
  readLoginToken,
  readSessionToken,
  setCookie,
} from '../src/lib/auth/session.ts';
import { BASE_PATH, normalizeBasePath, withoutBasePath } from '../src/lib/basePath.ts';
import { keySegment, keySegments } from '../src/lib/keys.ts';

/**
 * Settings as a build for the root reads them. Without the second argument the
 * sub-path of this very build would decide, and a build for `/stats` runs these
 * tests too.
 */
const read = (env: Record<string, string | undefined>, basePath = '') => readAuthConfig(env, basePath);

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const SECRET = 'a-secret-of-at-least-thirty-two-characters';
const GOOD = {
  AUTH_PUBLIC_URL: 'https://meet.example.org',
  AUTH_SECRET: SECRET,
  OIDC_ISSUER: 'https://meet.example.org/kc/realms/dev',
  OIDC_CLIENT_ID: 'stats',
  OIDC_CLIENT_SECRET: 'client-secret',
  OIDC_ALLOW_CLAIM: 'roles',
  OIDC_ALLOW_VALUES: 'stats-viewer',
};

function settings(env: Record<string, string | undefined> = {}, basePath = ''): AuthSettings {
  const config = read({ ...GOOD, ...env }, basePath);
  assert.equal(config.mode, 'oidc', JSON.stringify(config));
  return config as AuthSettings;
}

/**
 * The same settings for the checks that read the real environment. A build
 * for a sub-path runs these tests with NEXT_PUBLIC_BASE_PATH set, and the
 * address has to end in that path then.
 */
const HERE = { ...GOOD, AUTH_PUBLIC_URL: `${GOOD.AUTH_PUBLIC_URL}${BASE_PATH}` };

const AUTH_KEYS = [...Object.keys(GOOD), 'AUTH_DISABLED', 'AUTH_SESSION_TTL', 'OIDC_SCOPE'];

/** Run `fn` with exactly this environment for the sign-in settings. */
async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(AUTH_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const key of AUTH_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const key of AUTH_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key] as string;
    }
  }
}

// ── Settings ────────────────────────────────────────────────────────────────

console.log('an installation that says nothing is closed');

await check('no settings at all is "misconfigured", not "open"', () => {
  const config = read({});
  assert.equal(config.mode, 'misconfigured');
  assert.ok(config.mode === 'misconfigured' && config.problems.length >= 5);
});

await check('every required setting is named when it is missing', () => {
  for (const key of ['AUTH_PUBLIC_URL', 'AUTH_SECRET', 'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_ALLOW_CLAIM', 'OIDC_ALLOW_VALUES']) {
    const config = read({ ...GOOD, [key]: '' });
    assert.equal(config.mode, 'misconfigured', key);
    assert.ok(config.mode === 'misconfigured' && config.problems.some((p) => p.includes(key)), key);
  }
});

await check('there is no rule that means "everybody who can sign in"', () => {
  assert.equal(read({ ...GOOD, OIDC_ALLOW_VALUES: ' , ,' }).mode, 'misconfigured');
  assert.equal(read({ ...GOOD, OIDC_ALLOW_CLAIM: undefined }).mode, 'misconfigured');
});

await check('only the exact word switches the sign-in off', () => {
  assert.equal(read({ AUTH_DISABLED: 'true' }).mode, 'disabled');
  assert.equal(read({ AUTH_DISABLED: ' TRUE ' }).mode, 'disabled');
  for (const value of ['1', 'yes', 'on', 'false', '']) {
    assert.equal(read({ AUTH_DISABLED: value }).mode, 'misconfigured', value);
  }
});

await check('a short secret is refused', () => {
  assert.equal(read({ ...GOOD, AUTH_SECRET: 'short' }).mode, 'misconfigured');
});

await check('plain http is accepted on the machine itself only', () => {
  assert.equal(read({ ...GOOD, AUTH_PUBLIC_URL: 'http://meet.example.org' }).mode, 'misconfigured');
  assert.equal(read({ ...GOOD, OIDC_ISSUER: 'http://idp.example.org/realms/dev' }).mode, 'misconfigured');
  assert.equal(read({ ...GOOD, AUTH_PUBLIC_URL: 'http://localhost:3000' }).mode, 'oidc');
  assert.equal(read({ ...GOOD, OIDC_ISSUER: 'http://127.0.0.1:8080/realms/dev' }).mode, 'oidc');
  assert.equal(read({ ...GOOD, AUTH_PUBLIC_URL: 'javascript:alert(1)' }).mode, 'misconfigured');
  assert.equal(read({ ...GOOD, AUTH_PUBLIC_URL: 'https://user:pw@meet.example.org' }).mode, 'misconfigured');
  assert.equal(read({ ...GOOD, AUTH_PUBLIC_URL: 'https://meet.example.org/?x=1' }).mode, 'misconfigured');
});

await check('the public address keeps its sub-path and loses a trailing slash', () => {
  const root = settings({ AUTH_PUBLIC_URL: 'https://meet.example.org/' });
  assert.equal(publicHref(root, '/auth/callback'), 'https://meet.example.org/auth/callback');
  assert.equal(cookiePath(root), '/');

  const sub = settings({ AUTH_PUBLIC_URL: 'https://meet.example.org/stats/' }, '/stats');
  assert.equal(publicHref(sub, '/auth/callback'), 'https://meet.example.org/stats/auth/callback');
  assert.equal(cookiePath(sub), '/stats');
});

await check('an address whose path is not the one the build serves under is refused', () => {
  const underRoot = read({ ...GOOD, AUTH_PUBLIC_URL: 'https://meet.example.org/stats' }, '');
  assert.equal(underRoot.mode, 'misconfigured');
  assert.ok(underRoot.mode === 'misconfigured' && underRoot.problems.some((p) => p.includes('NEXT_PUBLIC_BASE_PATH')));
  assert.equal(read({ ...GOOD, AUTH_PUBLIC_URL: 'https://meet.example.org' }, '/stats').mode, 'misconfigured');
  assert.equal(read({ ...GOOD, AUTH_PUBLIC_URL: 'https://meet.example.org/other' }, '/stats').mode, 'misconfigured');
  assert.equal(read({ ...GOOD, AUTH_PUBLIC_URL: 'https://meet.example.org/stats' }, '/stats').mode, 'oidc');
});

await check('the sub-path is one or more plain segments, or nothing', () => {
  assert.equal(normalizeBasePath(undefined), '');
  assert.equal(normalizeBasePath(''), '');
  assert.equal(normalizeBasePath('/'), '');
  assert.equal(normalizeBasePath('/stats'), '/stats');
  assert.equal(normalizeBasePath('/stats/'), '/stats');
  assert.equal(normalizeBasePath('/tools/stats'), '/tools/stats');
  for (const bad of ['stats', '//evil.example', '/a b', '/a?b', '/a/../b/..', 'https://evil.example', '/a//b', '/"x']) {
    assert.throws(() => normalizeBasePath(bad), bad);
  }
});

await check('a path of the browser is turned into a path of the app', () => {
  assert.equal(withoutBasePath('/stats/room/call', '/stats'), '/room/call');
  assert.equal(withoutBasePath('/stats', '/stats'), '/');
  assert.equal(withoutBasePath('/statsx/room', '/stats'), '/statsx/room');
  assert.equal(withoutBasePath('/room', ''), '/room');
});

await check('the session lifetime has a default and a floor', () => {
  assert.equal(settings().sessionTtl, 8 * 60 * 60);
  assert.equal(settings({ AUTH_SESSION_TTL: '3600' }).sessionTtl, 3600);
  for (const value of ['0', '-5', '30', 'soon', '1.5']) {
    assert.equal(read({ ...GOOD, AUTH_SESSION_TTL: value }).mode, 'misconfigured', value);
  }
});

// ── The decision ────────────────────────────────────────────────────────────

console.log('\nwhat a request gets');

const PAGES = ['/', '/room', '/room/call', '/room/call/client', '/_next/image', '/observertc-logo.svg', '/authx', '/apix'];
const API = ['/api', '/api/room', '/api/room/call', '/api/room/call/client', '/api/room/call/call-summary',
  '/api/room/call/object/x.json', '/api/room/call/router/r1', '/api/session', '/api/health/more', '/api/healthz'];
const OPEN = ['/auth/login', '/auth/callback', '/auth/logout', '/api/health'];

await check('without a session a page goes to the sign-in and an API call gets 401', () => {
  for (const path of PAGES) assert.equal(gate(path, 'oidc', false), 'login', path);
  for (const path of API) assert.equal(gate(path, 'oidc', false), 'unauthenticated', path);
});

await check('with a session everything is served', () => {
  for (const path of [...PAGES, ...API, ...OPEN]) assert.equal(gate(path, 'oidc', true), 'allow', path);
});

await check('without settings nothing is served, session or not', () => {
  for (const path of [...PAGES, ...API]) {
    assert.equal(gate(path, 'misconfigured', false), 'unavailable', path);
    assert.equal(gate(path, 'misconfigured', true), 'unavailable', path);
  }
});

await check('the open paths are exactly the sign-in and the healthcheck', () => {
  for (const path of OPEN) {
    assert.equal(gate(path, 'oidc', false), 'allow', path);
    assert.equal(gate(path, 'misconfigured', false), 'allow', path);
  }
  for (const path of ['/auth', '/auth/', '/auth/login/', '/auth/login/x', '/auth/other', '/AUTH/login', '/api/health/', '/api/Health', '/api/health?x', '//auth/login']) {
    assert.equal(isOpenPath(path), false, path);
  }
});

await check('switched off means served', () => {
  for (const path of [...PAGES, ...API]) assert.equal(gate(path, 'disabled', false), 'allow', path);
});

await check('after signing in the user lands on this dashboard, wherever the link said', () => {
  for (const good of ['/', '/room', '/room/call/client?tab=2#producers', '/a%20b']) {
    assert.equal(safeReturnTo(good), good);
  }
  for (const bad of [
    null, undefined, '', 'room', 'https://evil.example', '//evil.example', '/\\evil.example', '/a\\b',
    '/a\nb', '/a\tb', 'javascript:alert(1)', '/auth/login', '/auth/callback?code=x', '/api', '/api/room',
    '/api?x=1', `/${'a'.repeat(2001)}`,
  ]) {
    assert.equal(safeReturnTo(bad), '/', String(bad));
  }
});

// ── The rule ────────────────────────────────────────────────────────────────

console.log('\nwho passes the rule');

const rule = { claim: 'roles', values: ['stats-viewer', 'stats-admin'] };

await check('a claim that is, or contains, an allowed value passes', () => {
  assert.equal(isAllowed({ roles: 'stats-viewer' }, rule), true);
  assert.equal(isAllowed({ roles: ['user', 'stats-admin'] }, rule), true);
});

await check('everything else does not', () => {
  for (const claims of [
    {}, { roles: null }, { roles: '' }, { roles: [] }, { roles: 'user' }, { roles: ['user'] },
    { roles: 'stats-viewer ' }, { roles: 'STATS-VIEWER' }, { roles: 'stats' },
    { roles: { 'stats-viewer': true } }, { roles: [['stats-viewer']] }, { roles: true }, { roles: 1 },
    { role: 'stats-viewer' },
  ]) {
    assert.equal(isAllowed(claims as Record<string, unknown>, rule), false, JSON.stringify(claims));
  }
});

await check('a rule without a claim or without values matches nobody', () => {
  assert.equal(isAllowed({ roles: 'x', '': 'x' }, { claim: '', values: ['x'] }), false);
  assert.equal(isAllowed({ roles: '' }, { claim: 'roles', values: [] }), false);
});

await check('a dotted path reaches into nested claims, and only into own fields', () => {
  const claims = { realm_access: { roles: ['stats-viewer'] }, list: ['a'] };
  assert.equal(isAllowed(claims, { claim: 'realm_access.roles', values: ['stats-viewer'] }), true);
  assert.equal(claimAt(claims, 'realm_access.missing'), undefined);
  assert.equal(claimAt(claims, 'list.0'), undefined);
  assert.equal(claimAt(claims, 'constructor'), undefined);
  assert.equal(claimAt(claims, '__proto__'), undefined);
  assert.equal(claimAt(claims, 'realm_access.constructor.name'), undefined);
  assert.equal(isAllowed(claims, { claim: 'constructor.name', values: ['Object'] }), false);
});

await check('an e-mail address counts only when the provider verified it', () => {
  const byMail = { claim: 'email', values: ['ann@example.org'] };
  assert.equal(isAllowed({ email: 'ann@example.org', email_verified: true }, byMail), true);
  assert.equal(isAllowed({ email: 'ann@example.org', email_verified: false }, byMail), false);
  assert.equal(isAllowed({ email: 'ann@example.org', email_verified: 'true' }, byMail), false);
  assert.equal(isAllowed({ email: 'ann@example.org' }, byMail), false);
});

// ── Cookies ─────────────────────────────────────────────────────────────────

console.log('\nthe session cookie');

await check('a session survives the round trip', async () => {
  const s = settings();
  const token = await createSessionToken(s, { sub: 'u1', name: 'Ann' });
  assert.deepEqual(await readSessionToken(SECRET, token), { sub: 'u1', name: 'Ann' });
});

await check('a changed, foreign or missing token is no session', async () => {
  const s = settings();
  const token = await createSessionToken(s, { sub: 'u1', name: 'Ann' });
  const [h, p, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), sub: 'admin' })).toString('base64url');

  assert.equal(await readSessionToken(SECRET, `${h}.${forged}.${sig}`), null);
  assert.equal(await readSessionToken('another-secret-of-thirty-two-characters!', token), null);
  assert.equal(await readSessionToken(SECRET, undefined), null);
  assert.equal(await readSessionToken(SECRET, ''), null);
  assert.equal(await readSessionToken(SECRET, 'not.a.token'), null);
});

await check('a token that names no algorithm, or another one, is refused', async () => {
  const payload = Buffer.from(JSON.stringify({
    sub: 'u1', name: 'Ann', iss: 'edumeet-stats-dashboard', aud: 'session', exp: Math.floor(Date.now() / 1000) + 600,
  })).toString('base64url');
  const none = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  assert.equal(await readSessionToken(SECRET, `${none}.${payload}.`), null);

  const hs512 = await new SignJWT({ name: 'Ann' }).setProtectedHeader({ alg: 'HS512' }).setSubject('u1')
    .setIssuer('edumeet-stats-dashboard').setAudience('session').setExpirationTime('10m')
    .sign(new TextEncoder().encode(SECRET.repeat(2)));
  assert.equal(await readSessionToken(SECRET.repeat(2), hs512), null);
});

await check('an expired session is no session', async () => {
  const key = new TextEncoder().encode(SECRET);
  const make = (exp: number) => new SignJWT({ name: 'Ann' }).setProtectedHeader({ alg: 'HS256' }).setSubject('u1')
    .setIssuer('edumeet-stats-dashboard').setAudience('session').setExpirationTime(exp).sign(key);
  const now = Math.floor(Date.now() / 1000);
  assert.deepEqual(await readSessionToken(SECRET, await make(now + 60)), { sub: 'u1', name: 'Ann' });
  assert.equal(await readSessionToken(SECRET, await make(now - 60)), null);
});

await check('the cookie of a sign-in attempt is not a session, and the other way round', async () => {
  const s = settings();
  const attempt = { state: 's', nonce: 'n', codeVerifier: 'v', returnTo: '/room' };
  const login = await createLoginToken(s, attempt);
  const session = await createSessionToken(s, { sub: 'u1', name: 'Ann' });

  assert.deepEqual(await readLoginToken(SECRET, login), attempt);
  assert.equal(await readSessionToken(SECRET, login), null);
  assert.equal(await readLoginToken(SECRET, session), null);
});

await check('over https the cookies are Secure, HttpOnly, Lax and limited to the sub-path', () => {
  const s = settings({ AUTH_PUBLIC_URL: 'https://meet.example.org/stats' }, '/stats');
  const names = cookieNames(s);
  assert.equal(names.session, '__Secure-stats_session');
  assert.equal(names.login, '__Secure-stats_login');
  assert.equal(
    setCookie(s, names.session, 'tok', 600),
    '__Secure-stats_session=tok; Path=/stats; Max-Age=600; HttpOnly; SameSite=Lax; Secure',
  );
  assert.match(setCookie(s, names.session, '', 0), /Max-Age=0/);
});

await check('on localhost over http they work without the Secure parts', () => {
  const s = settings({ AUTH_PUBLIC_URL: 'http://localhost:3000' });
  assert.equal(cookieNames(s).session, 'stats_session');
  assert.equal(setCookie(s, 'stats_session', 'tok', 600), 'stats_session=tok; Path=/; Max-Age=600; HttpOnly; SameSite=Lax');
});

await check('one cookie is read by its exact name', () => {
  const header = 'a=1; xstats_session=wrong; stats_session=right; stats_session_old=wrong';
  assert.equal(readCookie(header, 'stats_session'), 'right');
  assert.equal(readCookie(header, 'missing'), undefined);
  assert.equal(readCookie(null, 'stats_session'), undefined);
  assert.equal(readCookie('stats_session=a=b=c', 'stats_session'), 'a=b=c');
});

// ── The check inside the routes ─────────────────────────────────────────────

console.log('\nthe check inside each API route');

const request = (cookie?: string) =>
  new Request('http://internal:3000/api', { headers: cookie ? { cookie } : {} });

await check('a handler does not run for a caller without a session', async () => {
  let ran = 0;
  const handler = guarded(async () => { ran += 1; return Response.json({ rooms: ['secret'] }); });

  await withEnv(HERE, async () => {
    const res = await handler(request(), undefined);
    assert.equal(res.status, 401);
    assert.doesNotMatch(await res.text(), /secret/);

    const forged = await handler(request('__Secure-stats_session=aaa.bbb.ccc'), undefined);
    assert.equal(forged.status, 401);
  });
  assert.equal(ran, 0);
});

await check('it runs with a session, and its answer is not for shared caches', async () => {
  const handler = guarded(async () => Response.json({ rooms: ['r1'] }));
  await withEnv(HERE, async () => {
    const token = await createSessionToken(settings(), { sub: 'u1', name: 'Ann' });
    const res = await handler(request(`__Secure-stats_session=${token}`), undefined);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
  });
});

await check('a session signed for another installation does not open this one', async () => {
  let ran = 0;
  const handler = guarded(async () => { ran += 1; return Response.json({}); });
  const token = await createSessionToken(settings({ AUTH_SECRET: 'the-secret-of-some-other-installation!!' }), { sub: 'u1', name: 'Ann' });
  await withEnv(HERE, async () => {
    assert.equal((await handler(request(`__Secure-stats_session=${token}`), undefined)).status, 401);
  });
  assert.equal(ran, 0);
});

await check('without settings it answers 503 and does not run', async () => {
  let ran = 0;
  const handler = guarded(async () => { ran += 1; return Response.json({}); });
  await withEnv({}, async () => {
    assert.equal((await handler(request(), undefined)).status, 503);
  });
  assert.equal(ran, 0);
});

await check('switched off, it runs', async () => {
  const handler = guarded(async () => Response.json({ ok: true }));
  await withEnv({ AUTH_DISABLED: 'true' }, async () => {
    assert.equal((await handler(request(), undefined)).status, 200);
  });
});

// ── Keys from the request path ──────────────────────────────────────────────

console.log('\nparts of a key taken from the address');

await check('a plain id is accepted, encoded or not', () => {
  for (const good of ['room1', 'a.b_c-d', 'client~1700000000000', 'A%20B', 'rooms.example.org']) {
    assert.equal(keySegment(good), decodeURIComponent(good));
  }
  assert.deepEqual(keySegments('room', 'call', 'client'), ['room', 'call', 'client']);
});

await check('anything that is more, or less, than one segment is refused', () => {
  for (const bad of ['', '.', '..', 'a/b', 'a%2Fb', 'a\\b', 'a%5Cb', '%2e%2e', 'a%00b', 'a%0Ab', '%', '%E0%A4%A', 'x'.repeat(301)]) {
    assert.equal(keySegment(bad), null, bad);
  }
  assert.equal(keySegment(undefined), null);
  assert.equal(keySegments('room', '..', 'client'), null);
});

// ── The source ──────────────────────────────────────────────────────────────

console.log('\nno route is left open by forgetting it');

const ROOT = join(import.meta.dirname, '..');

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name === 'route.ts' || name === 'route.tsx' ? [path] : [];
  });
}

await check('every handler under app/api is wrapped in guarded()', () => {
  const files = routeFiles(join(ROOT, 'app', 'api'));
  assert.ok(files.length >= 9, `found only ${files.length} route files`);

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const name = file.slice(ROOT.length + 1);
    const handlers = [...source.matchAll(/export\s+(?:async\s+function|const|function)\s+(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\b([^\n]*)/g)];
    assert.ok(handlers.length > 0, `${name} exports no handler`);

    // The healthcheck answers without a session, and decides itself how much.
    if (name === join('app', 'api', 'health', 'route.ts')) {
      assert.match(source, /mayRead\(caller\)/, `${name} must ask mayRead()`);
      continue;
    }
    for (const [, method, rest] of handlers) {
      assert.match(rest, /^\s*=\s*guarded\(/, `${name}: ${method} is not wrapped in guarded()`);
    }
  }
});

await check('the middleware runs for every path except the build\'s static files', () => {
  const source = readFileSync(join(ROOT, 'middleware.ts'), 'utf8');
  const matcher = source.match(/matcher:\s*\[([^\]]*)\]/);
  assert.ok(matcher, 'no matcher found');
  assert.equal(matcher[1].trim(), "'/((?!_next/static/).*)'");
});

console.log(`\n${passed} checks passed`);
