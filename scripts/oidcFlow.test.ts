/**
 * One sign-in from start to end, against a provider that runs inside the test.
 *
 *   node --experimental-strip-types scripts/oidcFlow.test.ts
 *
 * The provider below listens on 127.0.0.1 and can be told to answer wrongly:
 * a token signed by somebody else, for another client, for another attempt.
 * Each of those is an attack on a sign-in, and each must end without claims.
 * No network is needed.
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { readAuthConfig, type AuthSettings } from '../src/lib/auth/config.ts';
import { beginLogin, endSessionUrl, finishLogin } from '../src/lib/auth/oidc.ts';
import { isAllowed } from '../src/lib/auth/rule.ts';

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// ── A provider that does what it is told ────────────────────────────────────

const { publicKey, privateKey } = await generateKeyPair('RS256');
const stranger = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };

interface Issued {
  challenge: string;
  nonce: string;
}
const codes = new Map<string, Issued>();

/** What the next token answer deviates in. Reset after each check. */
let wrong: {
  nonce?: string;
  audience?: string;
  issuer?: string;
  expired?: boolean;
  foreignKey?: boolean;
} = {};
let idTokenClaims: Record<string, unknown> = {};
let userinfoClaims: Record<string, unknown> = {};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', issuer);
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === '/.well-known/openid-configuration') {
    return send(200, {
      issuer,
      authorization_endpoint: `${issuer}/auth`,
      token_endpoint: `${issuer}/token`,
      userinfo_endpoint: `${issuer}/userinfo`,
      end_session_endpoint: `${issuer}/logout`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
    });
  }
  if (url.pathname === '/jwks') return send(200, { keys: [jwk] });

  if (url.pathname === '/token' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const form = new URLSearchParams(raw);
    const issued = codes.get(form.get('code') ?? '');
    codes.delete(form.get('code') ?? '');
    const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
    if (!issued || issued.challenge !== challenge) return send(400, { error: 'invalid_grant' });

    const now = Math.floor(Date.now() / 1000);
    const idToken = await new SignJWT({ nonce: wrong.nonce ?? issued.nonce, ...idTokenClaims })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(wrong.issuer ?? issuer)
      .setAudience(wrong.audience ?? 'stats')
      .setSubject('user-1')
      .setIssuedAt(wrong.expired ? now - 7200 : now)
      .setExpirationTime(wrong.expired ? now - 3600 : now + 300)
      .sign(wrong.foreignKey ? stranger.privateKey : privateKey);
    return send(200, { access_token: 'at-1', token_type: 'Bearer', expires_in: 300, id_token: idToken });
  }

  if (url.pathname === '/userinfo') {
    if (req.headers.authorization !== 'Bearer at-1') return send(401, { error: 'invalid_token' });
    return send(200, userinfoClaims);
  }
  return send(404, {});
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const settings = readAuthConfig({
  AUTH_PUBLIC_URL: 'https://meet.example.org/stats',
  AUTH_SECRET: 'a-secret-of-at-least-thirty-two-characters',
  OIDC_ISSUER: issuer,
  OIDC_CLIENT_ID: 'stats',
  OIDC_CLIENT_SECRET: 'client-secret',
  OIDC_ALLOW_CLAIM: 'roles',
  OIDC_ALLOW_VALUES: 'stats-viewer',
}, '/stats') as AuthSettings;
assert.equal(settings.mode, 'oidc');

/** The user signs in at the provider: it hands out a code for this attempt. */
function approve(authorizationUrl: URL): string {
  const code = randomUUID();
  codes.set(code, {
    challenge: authorizationUrl.searchParams.get('code_challenge') ?? '',
    nonce: authorizationUrl.searchParams.get('nonce') ?? '',
  });
  return code;
}

const callbackQuery = (code: string, state: string) =>
  `?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;

function reset() {
  wrong = {};
  idTokenClaims = { name: 'Ann Example', roles: ['stats-viewer'] };
  userinfoClaims = { sub: 'user-1', email: 'ann@example.org', groups: ['/operators'] };
}

try {
  console.log('a sign-in that is in order');

  await check('the browser is sent to the provider with a code flow and PKCE', async () => {
    reset();
    const { url, attempt } = await beginLogin(settings, '/room/call');
    assert.equal(`${url.origin}${url.pathname}`, `${issuer}/auth`);
    const q = url.searchParams;
    assert.equal(q.get('response_type'), 'code');
    assert.equal(q.get('client_id'), 'stats');
    assert.equal(q.get('redirect_uri'), 'https://meet.example.org/stats/auth/callback');
    assert.equal(q.get('scope'), 'openid profile email');
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.equal(q.get('code_challenge'), createHash('sha256').update(attempt.codeVerifier).digest('base64url'));
    assert.equal(q.get('state'), attempt.state);
    assert.equal(q.get('nonce'), attempt.nonce);
    assert.equal(q.get('prompt'), null);
    assert.equal(attempt.returnTo, '/room/call');
    // The verifier itself never leaves for the provider's sign-in page.
    assert.ok(!url.href.includes(attempt.codeVerifier));
  });

  await check('two attempts share nothing', async () => {
    const a = (await beginLogin(settings, '/')).attempt;
    const b = (await beginLogin(settings, '/')).attempt;
    assert.notEqual(a.state, b.state);
    assert.notEqual(a.nonce, b.nonce);
    assert.notEqual(a.codeVerifier, b.codeVerifier);
  });

  await check('"another account" asks the provider for its sign-in form', async () => {
    const { url } = await beginLogin(settings, '/', { freshLogin: true });
    assert.equal(url.searchParams.get('prompt'), 'login');
  });

  await check('the code is exchanged and the claims of ID token and userinfo come back', async () => {
    reset();
    const { url, attempt } = await beginLogin(settings, '/');
    const claims = await finishLogin(settings, callbackQuery(approve(url), attempt.state), attempt);
    assert.equal(claims.sub, 'user-1');
    assert.equal(claims.name, 'Ann Example');
    assert.equal(claims.email, 'ann@example.org');
    assert.deepEqual(claims.groups, ['/operators']);
    assert.equal(isAllowed(claims, settings.oidc.rule), true);
  });

  await check('where both name a claim, the signed ID token decides', async () => {
    reset();
    idTokenClaims = { roles: ['user'] };
    userinfoClaims = { sub: 'user-1', roles: ['stats-viewer'] };
    const { url, attempt } = await beginLogin(settings, '/');
    const claims = await finishLogin(settings, callbackQuery(approve(url), attempt.state), attempt);
    assert.deepEqual(claims.roles, ['user']);
    assert.equal(isAllowed(claims, settings.oidc.rule), false);
  });

  await check('a role that only userinfo names counts', async () => {
    reset();
    idTokenClaims = {};
    userinfoClaims = { sub: 'user-1', roles: ['stats-viewer'] };
    const { url, attempt } = await beginLogin(settings, '/');
    const claims = await finishLogin(settings, callbackQuery(approve(url), attempt.state), attempt);
    assert.equal(isAllowed(claims, settings.oidc.rule), true);
  });

  await check('a userinfo answer about somebody else adds nothing', async () => {
    reset();
    idTokenClaims = {};
    userinfoClaims = { sub: 'user-2', roles: ['stats-viewer'] };
    const { url, attempt } = await beginLogin(settings, '/');
    const claims = await finishLogin(settings, callbackQuery(approve(url), attempt.state), attempt);
    assert.equal(claims.sub, 'user-1');
    assert.equal(claims.roles, undefined);
    assert.equal(isAllowed(claims, settings.oidc.rule), false);
  });

  console.log('\na sign-in that is not');

  const refused = async (name: string, prepare: () => void, query?: (code: string, state: string) => string) =>
    check(name, async () => {
      reset();
      const { url, attempt } = await beginLogin(settings, '/');
      prepare();
      const code = approve(url);
      await assert.rejects(finishLogin(settings, (query ?? callbackQuery)(code, attempt.state), attempt));
    });

  await refused('the answer carries another state', () => {}, (code) => callbackQuery(code, 'somebody-elses-state'));
  await refused('the answer carries no state', () => {}, (code) => `?code=${code}`);
  await refused('the provider reports an error', () => {}, (_code, state) => `?error=access_denied&state=${state}`);
  await refused('the answer carries no code', () => {}, (_code, state) => `?state=${state}`);
  await refused('the ID token was signed by somebody else', () => { wrong.foreignKey = true; });
  await refused('the ID token was made for another client', () => { wrong.audience = 'another-client'; });
  await refused('the ID token names another issuer', () => { wrong.issuer = 'https://idp.evil.example'; });
  await refused('the ID token belongs to another attempt', () => { wrong.nonce = 'another-nonce'; });
  await refused('the ID token has expired', () => { wrong.expired = true; });
  await refused('the answer names another issuer than the one configured', () => {},
    (code, state) => `${callbackQuery(code, state)}&iss=${encodeURIComponent('https://idp.evil.example')}`);

  await check('a code is not accepted with the verifier of another attempt', async () => {
    reset();
    const mine = await beginLogin(settings, '/');
    const theirs = await beginLogin(settings, '/');
    // Somebody got hold of a code that was issued for another browser.
    const stolen = approve(theirs.url);
    await assert.rejects(finishLogin(settings, callbackQuery(stolen, mine.attempt.state), mine.attempt));
  });

  await check('a code works once', async () => {
    reset();
    const { url, attempt } = await beginLogin(settings, '/');
    const query = callbackQuery(approve(url), attempt.state);
    await finishLogin(settings, query, attempt);
    await assert.rejects(finishLogin(settings, query, attempt));
  });

  console.log('\nsigning out');

  await check('the provider is asked to end its session and to send the browser back here', async () => {
    const href = await endSessionUrl(settings);
    assert.ok(href);
    const url = new URL(href);
    assert.equal(`${url.origin}${url.pathname}`, `${issuer}/logout`);
    assert.equal(url.searchParams.get('client_id'), 'stats');
    assert.equal(url.searchParams.get('post_logout_redirect_uri'), 'https://meet.example.org/stats/auth/logout');
  });
} finally {
  server.close();
}

console.log(`\n${passed} checks passed`);
