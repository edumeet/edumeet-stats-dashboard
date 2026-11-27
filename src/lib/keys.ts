/**
 * One part of an object key, as it arrives in a request path.
 *
 * Keys are `<room>/<call>/<file>`. Each part comes from the address the browser
 * asked for, so it is checked before it becomes part of a key: one segment, no
 * separator, nothing a storage service or a log could read as something else.
 * `null` means the request does not name an object this dashboard serves.
 */
const MAX_SEGMENT_LENGTH = 300;

export function keySegment(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let segment: string;
  try {
    segment = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (segment === '' || segment.length > MAX_SEGMENT_LENGTH) return null;
  if (segment === '.' || segment === '..') return null;
  if (/[/\\\u0000-\u001f\u007f]/.test(segment)) return null;
  return segment;
}

/** All parts, or `null` when one of them is not a segment. */
export function keySegments(...raw: Array<string | undefined>): string[] | null {
  const segments: string[] = [];
  for (const part of raw) {
    const segment = keySegment(part);
    if (segment === null) return null;
    segments.push(segment);
  }
  return segments;
}
