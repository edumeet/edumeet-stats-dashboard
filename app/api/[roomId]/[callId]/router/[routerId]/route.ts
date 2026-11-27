import { NextResponse } from 'next/server';
import { guarded } from '@/lib/auth/guard';
import { keySegments } from '@/lib/keys';
import { s3Client, bucketName, toStorageKey } from '@/lib/s3';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { MediasoupRouterSample } from '@/schema/MediasoupRouter';

/**
 * Never prerendered.
 *
 * A route handler with no dynamic segment can be evaluated at build time, which
 * in a container image would bake the *build machine's* view of the bucket into
 * the image — normally an empty list, since the build has no credentials. Every
 * response here depends on storage as it is right now.
 */
export const dynamic = 'force-dynamic';

// GET /api/:roomId/:callId/router/:routerId — fetch and return the router sample JSON
export const GET = guarded(async (
  _req: Request,
  { params }: { params: Promise<{ roomId: string; callId: string; routerId: string }> },
) => {
  const raw = await params;
  const segments = keySegments(raw.roomId, raw.callId, raw.routerId);
  if (!segments) return NextResponse.json({ success: false, router: null }, { status: 400 });
  const [roomId, callId, routerId] = segments;
  const key = `${roomId}/${callId}/mediasoup-router-${routerId}.json`;
  try {
    const obj = await s3Client().send(new GetObjectCommand({ Bucket: bucketName(), Key: toStorageKey(key) }));
    const text = await obj.Body?.transformToString();
    if (!text) return NextResponse.json({ success: false, router: null }, { status: 404 });
    const router: MediasoupRouterSample = JSON.parse(text);
    return NextResponse.json({ success: true, router });
  } catch {
    return NextResponse.json({ success: false, router: null }, { status: 404 });
  }
});
