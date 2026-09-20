/**
 * Server-side proxy to the engine's policy list.
 *
 * The engine requires `Authorization: Bearer <AGENTGATE_API_KEY>`. The browser
 * cannot hold that key: every NEXT_PUBLIC_* variable is inlined into the client
 * bundle, so shipping it there would publish the credential to anyone who opens
 * the page — and the engine's key also authorises /evaluate, which spends money.
 *
 * So the key stays server-side, in a variable deliberately NOT prefixed
 * NEXT_PUBLIC_, and the browser talks to this route instead.
 */
import { NextResponse } from 'next/server';

// Never prerender: the policy list is live state, and a build-time snapshot
// would show a stale set of rules on a security console.
export const dynamic = 'force-dynamic';

const ENGINE = process.env.ENGINE_URL ?? process.env.NEXT_PUBLIC_ENGINE_URL ?? 'http://localhost:8000';
const KEY = process.env.AGENTGATE_API_KEY ?? '';

export async function GET() {
  try {
    const res = await fetch(`${ENGINE}/policies`, {
      headers: KEY ? { Authorization: `Bearer ${KEY}` } : {},
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });

    if (res.status === 401) {
      // Say which side is unconfigured. "401" alone sends someone looking at
      // the engine when the missing piece is this app's own environment.
      return NextResponse.json(
        { error: 'engine rejected the dashboard key — set AGENTGATE_API_KEY (no NEXT_PUBLIC_ prefix) for the dashboard process' },
        { status: 401 },
      );
    }
    if (!res.ok) {
      return NextResponse.json({ error: `engine returned ${res.status}` }, { status: 502 });
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    return NextResponse.json(
      { error: `cannot reach the engine at ${ENGINE}: ${(err as Error).message}` },
      { status: 503 },
    );
  }
}
