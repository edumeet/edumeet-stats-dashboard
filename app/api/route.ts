import { NextResponse } from 'next/server';
import { guarded } from '@/lib/auth/guard';
import { ListingBusyError } from '@/lib/listing';
import { announceStorageConfig, listFolders } from '@/lib/s3';

/**
 * Never prerendered.
 *
 * A route handler with no dynamic segment can be evaluated at build time, which
 * in a container image would bake the *build machine's* view of the bucket into
 * the image — normally an empty list, since the build has no credentials. Every
 * response here depends on storage as it is right now.
 */
export const dynamic = 'force-dynamic';

// GET /api — list all rooms with their most recently modified timestamp
export const GET = guarded(async (request: Request) => {
  announceStorageConfig();
  try {
    const { entries, truncated, activityPartial } = await listFolders('', request.signal);
    return NextResponse.json({ success: true, rooms: entries, truncated, activityPartial });
  } catch (err) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    if (err instanceof ListingBusyError) {
      return NextResponse.json({ success: false, rooms: [], error: err.message }, { status: 503 });
    }
    console.error('[api/rooms]', err);
    return NextResponse.json({ success: false, rooms: [] }, { status: 500 });
  }
});
