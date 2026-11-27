/**
 * The room list and the call list, at a cost that does not grow with the bucket.
 *
 * A bucket only ever gets fuller: every participant of every meeting adds an
 * object, and nothing removes them. Reading every key to find the rooms, on
 * every request, makes the first page slower each week and lets a few reloads
 * keep the server busy for minutes.
 *
 * So a listing is made in two bounded steps:
 *
 *   1. The folder names, from a listing with a delimiter. Storage answers with
 *      the folders themselves, a thousand per call, however many objects lie
 *      below them.
 *   2. When each folder last changed, from a plain listing that stops after a
 *      fixed number of pages. Folders it did not reach are shown without a
 *      time, after the others.
 *
 * And the result is shared: requests for the same folder while a listing runs
 * wait for that one, and for half a minute afterwards they get its answer. A
 * listing nobody waits for any more is stopped.
 */

export interface ListedObject {
  key: string;
  lastModified?: Date;
}

export interface ListedPage {
  objects: ListedObject[];
  /** Folder names directly below the prefix, with their trailing slash. Only with a delimiter. */
  folders: string[];
  /** Set when storage has more. */
  next?: string;
}

/** One page of a listing. `prefix` and the keys returned are relative to `S3_PREFIX`. */
export type PageLister = (request: {
  prefix: string;
  delimiter?: '/';
  token?: string;
  signal?: AbortSignal;
}) => Promise<ListedPage>;

export interface FolderEntry {
  id: string;
  /** Epoch ms of the newest object seen in the folder. Absent when step 2 did not reach it. */
  lastModified?: number;
}

export interface FolderListing {
  entries: FolderEntry[];
  /** There are more folders than `maxFolderPages` pages hold; the list is cut. */
  truncated: boolean;
  /** Step 2 stopped early: some entries have no time, or an older one than is true. */
  activityPartial: boolean;
}

export interface ListingLimits {
  /** Pages of folder names per listing. A page holds up to 1000. */
  maxFolderPages: number;
  /** Pages of objects read for the times per listing. A page holds up to 1000. */
  maxActivityPages: number;
  /** How long a finished listing is reused, in ms. */
  ttlMs: number;
  /** Listings that may run at the same time. */
  maxConcurrent: number;
  /** Listings that may wait for a free slot before new ones are refused. */
  maxQueued: number;
  /** Finished listings kept. */
  maxCached: number;
}

export const DEFAULT_LIMITS: ListingLimits = {
  maxFolderPages: 10,
  maxActivityPages: 50,
  ttlMs: 30_000,
  maxConcurrent: 2,
  maxQueued: 20,
  maxCached: 200,
};

export class ListingBusyError extends Error {
  constructor() {
    super('Too many listings are running. Try again in a moment.');
    this.name = 'ListingBusyError';
  }
}

interface Shared {
  promise: Promise<FolderListing>;
  controller: AbortController;
  waiters: number;
  /** Set when the listing finished; the entry is then a cached answer. */
  doneAt?: number;
}

export function createFolderLister(listPage: PageLister, overrides: Partial<ListingLimits> = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const shared = new Map<string, Shared>();
  let running = 0;
  const queue: Array<() => void> = [];

  async function withSlot<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    if (running >= limits.maxConcurrent) {
      if (queue.length >= limits.maxQueued) throw new ListingBusyError();
      await new Promise<void>((resolve, reject) => {
        const start = () => {
          signal.removeEventListener('abort', giveUp);
          resolve();
        };
        const giveUp = () => {
          const at = queue.indexOf(start);
          if (at >= 0) queue.splice(at, 1);
          reject(signal.reason);
        };
        queue.push(start);
        signal.addEventListener('abort', giveUp, { once: true });
      });
    }
    running += 1;
    try {
      return await work();
    } finally {
      running -= 1;
      queue.shift()?.();
    }
  }

  async function scan(prefix: string, signal: AbortSignal): Promise<FolderListing> {
    const idOf = (key: string): string => key.slice(prefix.length).split('/')[0];

    // Step 1: the names.
    const ids = new Set<string>();
    let token: string | undefined;
    let pages = 0;
    do {
      const page = await listPage({ prefix, delimiter: '/', token, signal });
      for (const folder of page.folders) {
        const id = idOf(folder);
        if (id) ids.add(id);
      }
      token = page.next;
      pages += 1;
    } while (token && pages < limits.maxFolderPages);
    const truncated = Boolean(token);

    // Step 2: the times, as far as the budget reaches.
    const newest = new Map<string, number>();
    token = undefined;
    pages = 0;
    do {
      const page = await listPage({ prefix, token, signal });
      for (const { key, lastModified } of page.objects) {
        const id = idOf(key);
        // An object directly in the folder is not a folder below it.
        if (!id || !key.slice(prefix.length).includes('/')) continue;
        const at = lastModified?.getTime() ?? 0;
        if (at > (newest.get(id) ?? 0)) newest.set(id, at);
        // Never more names than step 1 may return, whatever step 2 comes across.
        if (!truncated) ids.add(id);
      }
      token = page.next;
      pages += 1;
    } while (token && pages < limits.maxActivityPages);
    const activityPartial = Boolean(token);

    const entries: FolderEntry[] = [...ids].map((id) => ({ id, lastModified: newest.get(id) || undefined }));
    // Newest first; folders without a time after them, by name.
    entries.sort(
      (a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    return { entries, truncated, activityPartial };
  }

  function prune(now: number) {
    for (const [key, entry] of shared) {
      if (entry.doneAt !== undefined && now - entry.doneAt >= limits.ttlMs) shared.delete(key);
    }
    // Oldest finished answers go first when there are too many.
    for (const [key, entry] of shared) {
      if (shared.size <= limits.maxCached) break;
      if (entry.doneAt !== undefined) shared.delete(key);
    }
  }

  /**
   * The folders directly below `prefix` (`''` for rooms, `<room>/` for calls).
   * `signal` is the caller's: when every caller of a running listing has left,
   * the listing stops.
   */
  async function folders(prefix: string, signal?: AbortSignal): Promise<FolderListing> {
    prune(Date.now());

    let entry = shared.get(prefix);
    if (!entry) {
      const controller = new AbortController();
      const created: Shared = {
        controller,
        waiters: 0,
        promise: withSlot(controller.signal, () => scan(prefix, controller.signal)),
      };
      created.promise.then(
        () => {
          created.doneAt = Date.now();
        },
        () => {
          // A failed listing is not an answer to keep.
          if (shared.get(prefix) === created) shared.delete(prefix);
        },
      );
      shared.set(prefix, created);
      entry = created;
    }
    if (entry.doneAt !== undefined) return entry.promise;

    const current = entry;
    current.waiters += 1;
    // A caller without a signal cannot leave, so it keeps the listing alive.
    if (!signal) return current.promise;
    return new Promise<FolderListing>((resolve, reject) => {
      const leave = () => {
        current.waiters -= 1;
        if (current.waiters === 0 && current.doneAt === undefined) {
          if (shared.get(prefix) === current) shared.delete(prefix);
          current.controller.abort(new DOMException('Nobody waits for this listing any more.', 'AbortError'));
        }
        reject(signal.reason);
      };
      if (signal.aborted) return leave();
      signal.addEventListener('abort', leave, { once: true });
      current.promise.then(
        (value) => {
          signal.removeEventListener('abort', leave);
          resolve(value);
        },
        (err) => {
          signal.removeEventListener('abort', leave);
          reject(err);
        },
      );
    });
  }

  return { folders };
}
