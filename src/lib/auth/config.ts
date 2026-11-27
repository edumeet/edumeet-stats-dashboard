/**
 * Who may open the dashboard, configured from the environment.
 *
 * The bucket holds the diagnostics of every meeting: names, IP addresses,
 * devices. So the dashboard serves nothing until it knows who is asking. There
 * are three states and no fourth:
 *
 *   oidc           sign-in with OpenID Connect is configured. The normal state.
 *   disabled       `AUTH_DISABLED=true`. For a developer's own machine only.
 *   misconfigured  anything else, including "nothing set". Every request is
 *                  refused, so an installation that forgot the settings is
 *                  closed, not open.
 *
 * Read at run time, like the storage settings, so one image serves any
 * installation. Used by the middleware too, so this file imports nothing that
 * needs Node.
 */

export interface AccessRule {
  /** Dotted path of the claim, for example `roles` or `realm_access.roles`. */
  claim: string;
  /** The user is let in when the claim equals, or contains, one of these. */
  values: string[];
}

export interface OidcSettings {
  issuer: URL;
  clientId: string;
  /** Empty for a public client, which then relies on PKCE alone. */
  clientSecret: string;
  scope: string;
  rule: AccessRule;
}

export interface AuthSettings {
  mode: 'oidc';
  /** The address users type, with the sub-path if there is one. */
  publicUrl: URL;
  /** The sub-path of that address without a trailing slash: `/stats`, or `''` at the root. */
  basePath: string;
  /** Signs the session cookie. */
  secret: string;
  /** Lifetime of a session in seconds. */
  sessionTtl: number;
  oidc: OidcSettings;
}

export type AuthConfig =
  | AuthSettings
  | { mode: 'disabled' }
  | { mode: 'misconfigured'; problems: string[] };

type Env = Record<string, string | undefined>;

const DEFAULT_SESSION_TTL = 8 * 60 * 60;
const MIN_SECRET_LENGTH = 32;

const isLoopback = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

/** `https:` anywhere, `http:` only on the machine itself. */
function parseUrl(raw: string, name: string, problems: string[]): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`${name} is not a URL`);
    return undefined;
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    problems.push(`${name} must start with https:// (http:// is accepted for localhost only)`);
    return undefined;
  }
  if (url.search || url.hash || url.username || url.password) {
    problems.push(`${name} must not carry a query, a fragment or credentials`);
    return undefined;
  }
  return url;
}

export function readAuthConfig(env: Env = process.env): AuthConfig {
  if ((env.AUTH_DISABLED ?? '').trim().toLowerCase() === 'true') return { mode: 'disabled' };

  const problems: string[] = [];
  const value = (name: string): string => (env[name] ?? '').trim();
  const required = (name: string): string => {
    const v = value(name);
    if (!v) problems.push(`${name} is not set`);
    return v;
  };

  const rawPublicUrl = required('AUTH_PUBLIC_URL');
  const publicUrl = rawPublicUrl ? parseUrl(rawPublicUrl, 'AUTH_PUBLIC_URL', problems) : undefined;

  const secret = required('AUTH_SECRET');
  if (secret && secret.length < MIN_SECRET_LENGTH) {
    problems.push(`AUTH_SECRET must have at least ${MIN_SECRET_LENGTH} characters`);
  }

  const rawIssuer = required('OIDC_ISSUER');
  const issuer = rawIssuer ? parseUrl(rawIssuer, 'OIDC_ISSUER', problems) : undefined;
  const clientId = required('OIDC_CLIENT_ID');

  // No rule would mean "everybody the provider knows". On a provider where
  // people can register themselves that is everybody, so there is no default.
  const claim = required('OIDC_ALLOW_CLAIM');
  const rawValues = required('OIDC_ALLOW_VALUES');
  const values = rawValues
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (rawValues && values.length === 0) problems.push('OIDC_ALLOW_VALUES names no value');

  let sessionTtl = DEFAULT_SESSION_TTL;
  const rawTtl = value('AUTH_SESSION_TTL');
  if (rawTtl) {
    const parsed = Number(rawTtl);
    if (Number.isInteger(parsed) && parsed >= 60) sessionTtl = parsed;
    else problems.push('AUTH_SESSION_TTL must be a whole number of seconds, 60 or more');
  }

  if (problems.length > 0 || !publicUrl || !issuer) return { mode: 'misconfigured', problems };

  return {
    mode: 'oidc',
    publicUrl,
    basePath: publicUrl.pathname.replace(/\/+$/, ''),
    secret,
    sessionTtl,
    oidc: {
      issuer,
      clientId,
      clientSecret: value('OIDC_CLIENT_SECRET'),
      scope: value('OIDC_SCOPE') || 'openid profile email',
      rule: { claim, values },
    },
  };
}

/** `https://host/stats` + `/auth/login` -> `https://host/stats/auth/login`. */
export function publicHref(settings: AuthSettings, path: string): string {
  return `${settings.publicUrl.origin}${settings.basePath}${path}`;
}

/** The path the cookies are limited to: the sub-path, or `/`. */
export function cookiePath(settings: AuthSettings): string {
  return settings.basePath || '/';
}
