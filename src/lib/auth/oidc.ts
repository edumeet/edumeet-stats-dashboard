import * as oidc from 'openid-client';
import { publicHref, type AuthSettings } from './config.ts';
import type { LoginAttempt } from './session.ts';

/**
 * The OpenID Connect side of the sign-in: authorization code flow with PKCE.
 *
 * Everything that has to be right for the flow to be safe is left to
 * `openid-client`: the state, the nonce, the PKCE verifier, the issuer, the
 * audience and the signature of the ID token are checked there, against the
 * keys the provider publishes. This file only says which provider and which
 * client, and where the browser comes back to.
 *
 * Node only (route handlers). The middleware never talks to the provider.
 */

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const PROVIDER_TIMEOUT_S = 10;

let cached: { key: string; at: number; configuration: Promise<oidc.Configuration> } | undefined;

/**
 * The provider's metadata, read once and kept for an hour.
 *
 * A failed discovery is not kept: the provider may simply have been starting
 * up, and the next sign-in should ask again.
 */
function provider(settings: AuthSettings): Promise<oidc.Configuration> {
  const { issuer, clientId, clientSecret } = settings.oidc;
  const key = JSON.stringify([issuer.href, clientId, clientSecret]);
  if (cached && cached.key === key && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.configuration;

  const configuration = oidc
    .discovery(issuer, clientId, clientSecret || undefined, clientSecret ? undefined : oidc.None(), {
      timeout: PROVIDER_TIMEOUT_S,
      // http is accepted for a provider on this machine only (see config.ts).
      execute: issuer.protocol === 'http:' ? [oidc.allowInsecureRequests] : [],
    })
    .then((found) => {
      // Left alone, the library takes an ID token that came straight from the
      // token endpoint on the word of the TLS connection, as the specification
      // allows, and does not look at its signature. Here the signature is
      // checked as well, so that the sign-in does not rest on one thing.
      oidc.enableNonRepudiationChecks(found);
      return found;
    });
  const entry = { key, at: Date.now(), configuration };
  cached = entry;
  configuration.catch(() => {
    if (cached === entry) cached = undefined;
  });
  return configuration;
}

export const redirectUri = (settings: AuthSettings): string => publicHref(settings, '/auth/callback');

/** The provider's sign-in address for one attempt, and what to remember about it. */
export async function beginLogin(
  settings: AuthSettings,
  returnTo: string,
  options: { freshLogin?: boolean } = {},
): Promise<{ url: URL; attempt: LoginAttempt }> {
  const configuration = await provider(settings);

  const codeVerifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();

  const url = oidc.buildAuthorizationUrl(configuration, {
    redirect_uri: redirectUri(settings),
    scope: settings.oidc.scope,
    code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    state,
    nonce,
    // "Sign in with another account": without this the provider answers with
    // the account it still has a session for, and the user is stuck with it.
    ...(options.freshLogin ? { prompt: 'login' } : {}),
  });

  return { url, attempt: { state, nonce, codeVerifier, returnTo } };
}

/**
 * Exchange the code the browser came back with, and return the user's claims.
 *
 * Throws when anything about the answer is wrong. `query` is the query string
 * of the callback request; the rest of the address is ours, not the request's,
 * because behind a proxy the request names an internal host.
 */
export async function finishLogin(
  settings: AuthSettings,
  query: string,
  attempt: LoginAttempt,
): Promise<Record<string, unknown>> {
  const configuration = await provider(settings);
  const currentUrl = new URL(redirectUri(settings) + query);

  const tokens = await oidc.authorizationCodeGrant(configuration, currentUrl, {
    pkceCodeVerifier: attempt.codeVerifier,
    expectedState: attempt.state,
    expectedNonce: attempt.nonce,
    idTokenExpected: true,
  });

  const idClaims = tokens.claims();
  if (!idClaims) throw new Error('the provider sent no ID token');

  // Some providers put roles and groups into the userinfo answer only. It is
  // asked for with the access token of this very sign-in, and the library
  // checks that it is about the same user. Where both name a claim, the signed
  // ID token wins.
  let userinfo: Record<string, unknown> = {};
  try {
    userinfo = await oidc.fetchUserInfo(configuration, tokens.access_token, idClaims.sub);
  } catch {
    // A provider without a userinfo endpoint, or one that refuses: the ID
    // token alone decides.
  }

  return { ...userinfo, ...idClaims };
}

/**
 * Where to send the browser to end the provider's session too, or `null` when
 * the provider offers no such address.
 *
 * Signing out here alone would be undone by the next click on "Sign in": the
 * provider still knows the user and would send them straight back.
 */
export async function endSessionUrl(settings: AuthSettings): Promise<string | null> {
  try {
    const configuration = await provider(settings);
    if (!configuration.serverMetadata().end_session_endpoint) return null;
    return oidc.buildEndSessionUrl(configuration, {
      post_logout_redirect_uri: publicHref(settings, '/auth/logout'),
    }).href;
  } catch {
    return null;
  }
}
