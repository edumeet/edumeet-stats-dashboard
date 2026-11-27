/**
 * The room list and the call list on a bucket that has grown.
 *
 *   node --experimental-strip-types scripts/listing.test.ts
 *
 * A bucket only gets fuller, so the question for every check here is what one
 * request costs when there are hundreds of thousands of objects: how many
 * calls to storage, how many when a hundred people ask at once, and whether
 * the work stops when nobody waits for it. The storage below is a sorted list
 * of keys that counts what it is asked.
 */

import assert from 'node:assert/strict';
import { ListingBusyError, createFolderLister, type PageLister } from '../src/lib/listing.ts';

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const PAGE = 1000;
const T0 = 1_700_000_000_000;

/** S3 as far as a listing sees it: sorted keys, pages of a thousand, a delimiter. */
function bucket(objects: Array<[key: string, modified: number]>) {
  const sorted = [...objects].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const keys = sorted.map(([key]) => key);
  const stats = { calls: 0, objectsRead: 0, failNext: 0 };

  /** Index of the first key that is not below `value`. */
  const from = (value: string): number => {
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keys[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const listPage: PageLister = async ({ prefix, delimiter, token, signal }) => {
    stats.calls += 1;
    // A real call takes a moment; this is where a caller can leave.
    await new Promise((resolve) => setImmediate(resolve));
    if (signal?.aborted) throw signal.reason;
    if (stats.failNext > 0) {
      stats.failNext -= 1;
      throw new Error('storage did not answer');
    }

    const page = { objects: [] as { key: string; lastModified: Date }[], folders: [] as string[], next: undefined as string | undefined };
    let i = from(token ?? prefix);
    while (i < keys.length && keys[i].startsWith(prefix)) {
      if (page.objects.length + page.folders.length === PAGE) {
        page.next = keys[i];
        break;
      }
      const rest = keys[i].slice(prefix.length);
      const slash = delimiter ? rest.indexOf('/') : -1;
      if (slash >= 0) {
        const folder = prefix + rest.slice(0, slash + 1);
        page.folders.push(folder);
        // Everything below the folder is one entry, however much it is.
        i = from(`${folder}￿`);
      } else {
        page.objects.push({ key: keys[i], lastModified: new Date(sorted[i][1]) });
        stats.objectsRead += 1;
        i += 1;
      }
    }
    return page;
  };

  return { listPage, stats };
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** `rooms` rooms of `calls` calls of `clients` clients each. */
function meetings(rooms: number, calls: number, clients: number) {
  const objects: Array<[string, number]> = [];
  for (let r = 0; r < rooms; r++) {
    for (let c = 0; c < calls; c++) {
      for (let k = 0; k < clients; k++) {
        objects.push([`room${pad(r, 5)}/call${pad(c, 3)}/client${pad(k, 3)}.jsonl`, T0 + r * 1000 + c]);
      }
    }
  }
  return objects;
}

// ── What a listing says ─────────────────────────────────────────────────────

console.log('what a listing says');

await check('rooms come newest first, with the time of their newest object', async () => {
  const { listPage } = bucket([
    ['old/c1/a.jsonl', T0 + 1],
    ['new/c1/a.jsonl', T0 + 5],
    ['new/c2/a.jsonl', T0 + 9],
    ['mid/c1/a.jsonl', T0 + 4],
    ['mid/c1/call-summary.json', T0 + 6],
  ]);
  const { entries, truncated, activityPartial } = await createFolderLister(listPage).folders('');
  assert.deepEqual(entries, [
    { id: 'new', lastModified: T0 + 9 },
    { id: 'mid', lastModified: T0 + 6 },
    { id: 'old', lastModified: T0 + 1 },
  ]);
  assert.equal(truncated, false);
  assert.equal(activityPartial, false);
});

await check('the calls of one room do not include its neighbours', async () => {
  const { listPage } = bucket([
    ['room/c1/a.jsonl', T0 + 1],
    ['room/c2/a.jsonl', T0 + 2],
    ['room2/c9/a.jsonl', T0 + 3],
    ['roo/c8/a.jsonl', T0 + 4],
  ]);
  const { entries } = await createFolderLister(listPage).folders('room/');
  assert.deepEqual(entries.map((e) => e.id), ['c2', 'c1']);
});

await check('an object that lies directly in the folder is not a folder', async () => {
  const { listPage } = bucket([
    ['readme.txt', T0],
    ['room/c1/a.jsonl', T0 + 1],
  ]);
  const { entries } = await createFolderLister(listPage).folders('');
  assert.deepEqual(entries.map((e) => e.id), ['room']);
});

await check('an empty bucket is an empty list', async () => {
  const { listPage } = bucket([]);
  assert.deepEqual(await createFolderLister(listPage).folders(''), { entries: [], truncated: false, activityPartial: false });
});

// ── What it costs ───────────────────────────────────────────────────────────

console.log('\nwhat it costs on 300,000 objects');

const big = meetings(300, 10, 100);
assert.equal(big.length, 300_000);

await check('one request makes a bounded number of calls to storage', async () => {
  const { listPage, stats } = bucket(big);
  const { entries, truncated, activityPartial } = await createFolderLister(listPage).folders('');

  // One page of names, fifty pages of objects, and not one more.
  assert.equal(stats.calls, 1 + 50);
  assert.equal(stats.objectsRead, 50_000);

  // Every room is listed, though only fifty were reached for their time.
  assert.equal(entries.length, 300);
  assert.equal(truncated, false);
  assert.equal(activityPartial, true);
  assert.equal(entries.filter((e) => e.lastModified !== undefined).length, 50);
  // Rooms with a time first, the rest after them by name.
  assert.ok(entries.slice(0, 50).every((e) => e.lastModified !== undefined));
  assert.equal(entries[50].id, 'room00050');
  assert.equal(entries[299].id, 'room00299');
});

await check('another 100,000 objects cost nothing more', async () => {
  const { listPage, stats } = bucket(meetings(300, 10, 100).concat(
    Array.from({ length: 100_000 }, (_, i): [string, number] => [`zroom/call/extra${pad(i, 6)}.jsonl`, T0]),
  ));
  await createFolderLister(listPage).folders('');
  assert.equal(stats.calls, 1 + 50);
});

await check('a hundred requests at once are one listing', async () => {
  const { listPage, stats } = bucket(big);
  const lister = createFolderLister(listPage);
  const answers = await Promise.all(Array.from({ length: 100 }, () => lister.folders('', new AbortController().signal)));
  assert.equal(stats.calls, 1 + 50);
  assert.ok(answers.every((a) => a === answers[0]));
});

await check('a finished listing answers again for a while, then storage is asked anew', async () => {
  const { listPage, stats } = bucket(meetings(3, 2, 2));
  const lister = createFolderLister(listPage, { ttlMs: 40 });
  await lister.folders('');
  const after = stats.calls;
  await lister.folders('');
  await lister.folders('');
  assert.equal(stats.calls, after);

  await new Promise((resolve) => setTimeout(resolve, 60));
  await lister.folders('');
  assert.equal(stats.calls, after * 2);
});

await check('more rooms than a listing may name: the list is cut and says so', async () => {
  const many: Array<[string, number]> = Array.from({ length: 25_000 }, (_, i) => [`room${pad(i, 5)}/c/a.jsonl`, T0 + i]);
  const { listPage, stats } = bucket(many);
  const { entries, truncated } = await createFolderLister(listPage).folders('');
  assert.equal(truncated, true);
  assert.equal(entries.length, 10_000);
  // Ten pages of names, then the 25,000 objects, which fit the budget.
  assert.equal(stats.calls, 10 + 25);
});

// ── When nobody waits ───────────────────────────────────────────────────────

console.log('\nwhen the caller leaves');

await check('a listing nobody waits for stops', async () => {
  const { listPage, stats } = bucket(big);
  const lister = createFolderLister(listPage);
  const caller = new AbortController();
  const pending = lister.folders('', caller.signal);

  await new Promise((resolve) => setTimeout(resolve, 5));
  caller.abort();
  await assert.rejects(pending);

  const atAbort = stats.calls;
  assert.ok(atAbort < 51, `the listing had already finished after ${atAbort} calls`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(stats.calls <= atAbort + 1, `storage was asked ${stats.calls - atAbort} more times after the caller left`);
});

await check('it goes on while one caller is still there', async () => {
  const { listPage } = bucket(big);
  const lister = createFolderLister(listPage);
  const leaving = new AbortController();
  const staying = new AbortController();
  const gone = lister.folders('', leaving.signal);
  const kept = lister.folders('', staying.signal);

  await new Promise((resolve) => setTimeout(resolve, 5));
  leaving.abort();
  await assert.rejects(gone);
  assert.equal((await kept).entries.length, 300);
});

await check('a stopped listing is not an answer for the next caller', async () => {
  const { listPage } = bucket(big);
  const lister = createFolderLister(listPage);
  const caller = new AbortController();
  const pending = lister.folders('', caller.signal);
  caller.abort();
  await assert.rejects(pending);
  assert.equal((await lister.folders('', new AbortController().signal)).entries.length, 300);
});

await check('a caller that had already left gets nothing started', async () => {
  const { listPage, stats } = bucket(big);
  const caller = new AbortController();
  caller.abort();
  await assert.rejects(createFolderLister(listPage).folders('', caller.signal));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(stats.calls <= 1);
});

// ── When storage fails, or is busy ──────────────────────────────────────────

console.log('\nwhen something is wrong');

await check('a failed listing is not kept as the answer', async () => {
  const { listPage, stats } = bucket(meetings(3, 2, 2));
  const lister = createFolderLister(listPage);
  stats.failNext = 1;
  await assert.rejects(lister.folders(''), /storage did not answer/);
  assert.equal((await lister.folders('')).entries.length, 3);
});

await check('only so many listings run at once, and only so many wait', async () => {
  const { listPage } = bucket(meetings(6, 2, 2));
  const lister = createFolderLister(listPage, { maxConcurrent: 1, maxQueued: 2 });
  const results = await Promise.allSettled(
    ['room00000/', 'room00001/', 'room00002/', 'room00003/', 'room00004/'].map((p) => lister.folders(p)),
  );
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled', 'fulfilled', 'rejected', 'rejected']);
  assert.ok((results[3] as PromiseRejectedResult).reason instanceof ListingBusyError);
  // The slots are free again afterwards.
  assert.equal((await lister.folders('room00005/')).entries.length, 2);
});

await check('finished answers do not pile up without end', async () => {
  const { listPage, stats } = bucket(meetings(30, 1, 1));
  const lister = createFolderLister(listPage, { maxCached: 5 });
  for (let r = 0; r < 30; r++) await lister.folders(`room${pad(r, 5)}/`);
  const after = stats.calls;
  // The most recent ones are still there, the first ones are not.
  await lister.folders('room00029/');
  assert.equal(stats.calls, after);
  await lister.folders('room00000/');
  assert.ok(stats.calls > after);
});

console.log(`\n${passed} checks passed`);
