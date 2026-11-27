/**
 * The sub-path this build is served under: `/stats`, or `''` at the root.
 *
 * Set with `NEXT_PUBLIC_BASE_PATH` when the image is built. It cannot be a
 * run-time setting: the paths of the scripts and styles a page loads are
 * written into the pages by the build.
 *
 * For an installation that has one host name and puts each service under a
 * path of it, as eduMEET does with `/kc` and `/mgmt`.
 */
export function normalizeBasePath(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '');
  if (trimmed === '') return '';
  // Plain segments only. `.` and `..` are segments a browser resolves away.
  if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(trimmed) || /\/\.+(\/|$)/.test(trimmed)) {
    throw new Error(`NEXT_PUBLIC_BASE_PATH must look like /stats (got "${raw}")`);
  }
  return trimmed;
}

// Written out in full so that the build can replace it in browser code too.
export const BASE_PATH = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH);

/** `/stats/room` -> `/room`: a path as the app itself knows it. */
export function withoutBasePath(pathname: string, basePath: string = BASE_PATH): string {
  if (basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`))) {
    return pathname.slice(basePath.length) || '/';
  }
  return pathname;
}
