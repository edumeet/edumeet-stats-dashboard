import type { RoomListResponse, CallListResponse, ClientsResponse, ClientStatsResponse, CallSummaryResponse, RouterSampleResponse, CallObjectResponse } from './types.ts';

// Empty string = same-origin (Next.js serves /api/* from the same host).
// Set NEXT_PUBLIC_API_BASE_URL only when the API is on a different origin.
export const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';

/**
 * Every call to the API goes through here.
 *
 * A session ends while a page is open: it expires, or the user signed out in
 * another tab. The page itself is still there, and the next call answers 401.
 * Then the browser goes to the sign-in and comes back to where it was, instead
 * of the page showing an empty call as if there were no data.
 */
async function apiFetch(path: string, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(`${BASE_URL}${path}`, { signal });
  if (res.status === 401 && typeof window !== 'undefined') {
    const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.assign(`${BASE_URL}/auth/login?returnTo=${encodeURIComponent(here)}`);
  }
  return res;
}

/** The limits of a listing, in words, or `null` when it is complete. */
export function listingNote(what: 'rooms' | 'calls', hit: { truncated?: boolean; activityPartial?: boolean }): string | null {
  if (hit.truncated) {
    return `There are more ${what} than one list shows. The ones missing can still be opened by their id.`;
  }
  if (hit.activityPartial) {
    return `There is too much data to read every time stamp. Some ${what} are listed without one, after the others.`;
  }
  return null;
}

/** Who is signed in, or `null`: nobody, or the sign-in is switched off. */
export async function fetchSessionUser(signal?: AbortSignal): Promise<{ name: string } | null> {
  try {
    const res = await apiFetch(`/api/session`, signal);
    if (!res.ok) return null;
    const body = (await res.json()) as { user?: { name?: unknown } | null };
    return typeof body.user?.name === 'string' ? { name: body.user.name } : null;
  } catch {
    return null;
  }
}

export const SIGN_OUT_URL = `${BASE_URL}/auth/logout`;

export async function fetchRooms(signal?: AbortSignal): Promise<RoomListResponse> {
  const res = await apiFetch(`/api`, signal);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch rooms: ${res.status} ${res.statusText}. ${text}`);
  }
  return res.json();
}

export async function fetchCalls(roomId: string, signal?: AbortSignal): Promise<CallListResponse> {
  const res = await apiFetch(`/api/${encodeURIComponent(roomId)}`, signal);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch calls: ${res.status} ${res.statusText}. ${text}`);
  }
  return res.json();
}

export async function fetchClients(roomId: string, callId: string, signal?: AbortSignal): Promise<ClientsResponse> {
  const res = await apiFetch(`/api/${encodeURIComponent(roomId)}/${encodeURIComponent(callId)}`, signal);
  if (!res.ok) return { success: false, clients: [] };
  return res.json();
}

export async function fetchClientStats(roomId: string, callId: string, clientId: string, signal?: AbortSignal): Promise<ClientStatsResponse> {
  const res = await apiFetch(`/api/${encodeURIComponent(roomId)}/${encodeURIComponent(callId)}/${encodeURIComponent(clientId)}`, signal);
  if (!res.ok) return { stats: [] };
  return res.json();
}

export async function fetchSignedUrl(url: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    return res.text();
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return null;
  }
}

export async function fetchCallSummary(roomId: string, callId: string, signal?: AbortSignal): Promise<CallSummaryResponse> {
  try {
    const res = await apiFetch(`/api/${encodeURIComponent(roomId)}/${encodeURIComponent(callId)}/call-summary`, signal);
    if (!res.ok) return { success: false, summary: null };
    return res.json();
  } catch {
    return { success: false, summary: null };
  }
}

/**
 * The raw JSON of one object in a call folder, by its exact filename.
 *
 * Raw on purpose: `fetchCallSummary` returns the merged view of every per-SFU
 * summary, and this returns what a single file actually said — the question you
 * ask when the merged view looks wrong.
 */
export async function fetchCallObject(
  roomId: string,
  callId: string,
  name: string,
  signal?: AbortSignal,
): Promise<CallObjectResponse> {
  try {
    const res = await apiFetch(
      `/api/${encodeURIComponent(roomId)}/${encodeURIComponent(callId)}/object/${encodeURIComponent(name)}`,
      signal,
    );
    const body = (await res.json()) as CallObjectResponse;
    if (!res.ok) return { success: false, name, error: body?.error ?? `HTTP ${res.status}` };
    return body;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return { success: false, name, error: 'Could not reach the server.' };
  }
}

export async function fetchRouterSample(roomId: string, callId: string, routerId: string, signal?: AbortSignal): Promise<RouterSampleResponse> {
  try {
    const res = await apiFetch(`/api/${encodeURIComponent(roomId)}/${encodeURIComponent(callId)}/router/${encodeURIComponent(routerId)}`, signal);
    if (!res.ok) return { success: false, router: null };
    return res.json();
  } catch {
    return { success: false, router: null };
  }
}
