import { NextResponse } from 'next/server';
import { guarded } from '@/lib/auth/guard';
import { keySegments } from '@/lib/keys';
import { objectExists, presignGet } from '@/lib/s3';

/**
 * Never prerendered.
 *
 * A route handler with no dynamic segment can be evaluated at build time, which
 * in a container image would bake the *build machine's* view of the bucket into
 * the image — normally an empty list, since the build has no credentials. Every
 * response here depends on storage as it is right now.
 */
export const dynamic = 'force-dynamic';

// GET /api/:roomId/:callId/:clientId
// Returns a short-lived presigned URL the browser uses to fetch the .jsonl directly from storage.
//
// A signed URL is a permission to read that works without a session until it
// expires. So it is made only for a signed-in caller, and only for the sample
// file of a client that exists: three plain segments and a fixed extension,
// never a key taken from the request as it came.
export const GET = guarded(async (
  _req: Request,
  { params }: { params: Promise<{ roomId: string; callId: string; clientId: string }> },
) => {
  const raw = await params;
  const segments = keySegments(raw.roomId, raw.callId, raw.clientId);
  if (!segments) return NextResponse.json({ stats: [] }, { status: 400 });
  const [roomId, callId, clientId] = segments;
  try {
    const key = `${roomId}/${callId}/${clientId}.jsonl`;
    if (!(await objectExists(key))) return NextResponse.json({ stats: [] }, { status: 404 });
    const signedUrl = await presignGet(key);
    return NextResponse.json({ stats: [{ id: clientId, signedUrl }] });
  } catch (err) {
    console.error('[api/clientId]', err);
    return NextResponse.json({ stats: [] }, { status: 500 });
  }
});
