import { NextResponse } from 'next/server';
import { guarded } from '@/lib/auth/guard';
import { keySegment } from '@/lib/keys';
import { ListingBusyError } from '@/lib/listing';
import { listFolders } from '@/lib/s3';

/**
 * Never prerendered.
 *
 * A route handler with no dynamic segment can be evaluated at build time, which
 * in a container image would bake the *build machine's* view of the bucket into
 * the image — normally an empty list, since the build has no credentials. Every
 * response here depends on storage as it is right now.
 */
export const dynamic = 'force-dynamic';

// GET /api/:roomId — list calls with their most recently modified timestamp
export const GET = guarded(async (
  request: Request,
  { params }: { params: Promise<{ roomId: string }> },
) => {
  const roomId = keySegment((await params).roomId);
  if (roomId === null) return NextResponse.json({ success: false, calls: [] }, { status: 400 });
  try {
    const { entries, truncated, activityPartial } = await listFolders(`${roomId}/`, request.signal);
    return NextResponse.json({ success: true, calls: entries, truncated, activityPartial });
  } catch (err) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    if (err instanceof ListingBusyError) {
      return NextResponse.json({ success: false, calls: [], error: err.message }, { status: 503 });
    }
    console.error('[api/roomId]', err);
    return NextResponse.json({ success: false, calls: [] }, { status: 500 });
  }
});
