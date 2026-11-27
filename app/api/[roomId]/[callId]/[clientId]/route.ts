import { NextResponse } from 'next/server';
import { guarded } from '@/lib/auth/guard';
import { keySegments } from '@/lib/keys';
import { BASE_PATH } from '@/lib/basePath';
import { objectExists, presignGet, storageConfig } from '@/lib/s3';

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
// Returns where the browser fetches the .jsonl from: a short-lived presigned URL
// straight to storage, or this server's own samples route.
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
    // With S3_SAMPLES_VIA=server the browser reads the file from this server,
    // with its session, and storage does not have to be reachable from it.
    const signedUrl =
      storageConfig().samplesVia === 'server'
        ? `${BASE_PATH}/api/${[roomId, callId, clientId].map(encodeURIComponent).join('/')}/samples`
        : await presignGet(key);
    return NextResponse.json({ stats: [{ id: clientId, signedUrl }] });
  } catch (err) {
    console.error('[api/clientId]', err);
    return NextResponse.json({ stats: [] }, { status: 500 });
  }
});
