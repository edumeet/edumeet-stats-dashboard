/**
 * The few plain pages of the sign-in: "try again", "not allowed", "not
 * configured". Answered by route handlers and the middleware, before the app
 * itself may be shown, so they carry no script and load nothing.
 */

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface MessageLink {
  href: string;
  label: string;
}

export function messagePage(
  status: number,
  title: string,
  text: string,
  links: MessageLink[] = [],
  headers: Record<string, string> = {},
): Response {
  const anchors = links
    .map((l) => `<a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`)
    .join(' ');
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · edumeet Stats</title>
<style>
  body { font-family: Roboto, system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f6f8; color: #1f2933; }
  main { max-width: 28rem; padding: 2rem; background: #fff; border: 1px solid #d9dee5; border-radius: 8px; }
  h1 { font-size: 1.15rem; margin: 0 0 0.75rem; }
  p { margin: 0 0 1.25rem; line-height: 1.5; }
  a { display: inline-block; margin-right: 0.75rem; color: #1a56b0; }
  @media (prefers-color-scheme: dark) {
    body { background: #14171c; color: #e4e7eb; }
    main { background: #1d2127; border-color: #343a43; }
    a { color: #7fb0f5; }
  }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>${anchors}</main></body>
</html>`;

  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}
