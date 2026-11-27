import { NextResponse } from 'next/server';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { guarded } from '@/lib/auth/guard';
import { keySegments } from '@/lib/keys';
import { s3Client, bucketName, storageConfig, toStorageKey } from '@/lib/s3';

export const dynamic = 'force-dynamic';

/**
 * GET /api/:roomId/:callId/:clientId/samples
 *
 * The sample file of one client, passed through from storage, for
 * installations with `S3_SAMPLES_VIA=server`.
 *
 * The other way, a presigned URL, makes the browser fetch the file from
 * storage itself. Storage then has to be reachable from wherever the operator
 * sits, and the URL works for anybody who gets hold of it until it expires.
 * Through here storage can stay on an internal network, and the file is read
 * with the session like everything else.
 *
 * Streamed, not buffered: a long meeting's file is many megabytes.
 */
export const GET = guarded(async (
  request: Request,
  { params }: { params: Promise<{ roomId: string; callId: string; clientId: string }> },
) => {
  // Answers only where it was chosen, so that an installation on presigned
  // URLs does not get a second way to the files without deciding on it.
  if (storageConfig().samplesVia !== 'server') {
    return NextResponse.json({ success: false, error: 'Not enabled.' }, { status: 404 });
  }

  const raw = await params;
  const segments = keySegments(raw.roomId, raw.callId, raw.clientId);
  if (!segments) return NextResponse.json({ success: false, error: 'Not a sample file.' }, { status: 400 });
  const [roomId, callId, clientId] = segments;
  const key = `${roomId}/${callId}/${clientId}.jsonl`;

  try {
    const object = await s3Client().send(
      new GetObjectCommand({ Bucket: bucketName(), Key: toStorageKey(key) }),
      { abortSignal: request.signal },
    );
    if (!object.Body) return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 });

    const headers = new Headers({
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      // Never shown as a page of its own: the text in it is the participants'.
      'Content-Disposition': 'attachment',
      'X-Content-Type-Options': 'nosniff',
    });
    if (object.ContentLength !== undefined) headers.set('Content-Length', String(object.ContentLength));
    return new Response(object.Body.transformToWebStream(), { headers });
  } catch (err) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (status === 404 || (err as Error)?.name === 'NoSuchKey') {
      return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 });
    }
    console.error('[api/samples]', err);
    return NextResponse.json({ success: false, error: 'Storage did not answer.' }, { status: 502 });
  }
});
