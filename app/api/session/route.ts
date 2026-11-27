import { NextResponse } from 'next/server';
import { callerOf, guarded } from '@/lib/auth/guard';

export const dynamic = 'force-dynamic';

/**
 * GET /api/session
 *
 * Who is signed in, for the name and the "Sign out" button in the corner.
 * `user` is null when the sign-in is switched off, and the button stays away.
 */
export const GET = guarded(async (request: Request) => {
  const { session } = await callerOf(request);
  return NextResponse.json({ user: session ? { name: session.name } : null });
});
