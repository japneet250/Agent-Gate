'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { BenchmarkMetrics, DataProvider, EvaluatedAction, Policy } from './types';
import { MockProvider, provenance } from './mock-provider';
import { LiveProvider } from './live-provider';

export * from './types';
export { provenance };

export type DataMode = 'mock' | 'live';

export function configuredMode(): DataMode {
  return process.env.NEXT_PUBLIC_DATA_MODE === 'live' ? 'live' : 'mock';
}

/**
 * One provider per browser session. Swapping mode is a reload, not a hot swap —
 * a half-live/half-mock feed would be impossible to reason about on stage.
 *
 * Browser-only on purpose. A module-level singleton on the server is shared
 * across every request in that Node process, so any state it accumulated would
 * leak into server-rendered HTML that the client then disagrees with — a
 * hydration mismatch that only shows up under load. On the server this returns
 * a provider with no state and no timers, so SSR output is always the empty
 * feed and always matches the client's first render.
 */
let singleton: DataProvider | null = null;
export function getProvider(): DataProvider {
  if (typeof window === 'undefined') {
    // Fresh, inert instance per server render. Never started, never subscribed.
    return configuredMode() === 'live' ? new LiveProvider() : new MockProvider();
  }
  if (!singleton) {
    singleton = configuredMode() === 'live' ? new LiveProvider() : new MockProvider();
  }
  return singleton;
}

/**
 * The feed hook.
 *
 * Actions are kept newest-first and capped. The cap is not cosmetic: an
 * unbounded list re-renders every card on every tick and is exactly what drops
 * frames during the burst.
 */
const MAX_ROWS = 60;

export function useActionFeed() {
  const provider = useMemo(getProvider, []);
  // Always start empty so the server's HTML and the client's first render are
  // identical. Existing history is adopted in the effect below, after
  // hydration has already succeeded. Seeding from provider.history() during
  // render is what makes a returning navigation mismatch.
  const [actions, setActions] = useState<EvaluatedAction[]>([]);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    // Adopt whatever the singleton already saw (e.g. after client-side nav).
    const existing = provider.history();
    if (existing.length) setActions([...existing].reverse().slice(0, MAX_ROWS));

    const unsubscribe = provider.subscribe((a) => {
      setActions((prev) => {
        const next = [a, ...prev];
        return next.length > MAX_ROWS ? next.slice(0, MAX_ROWS) : next;
      });
    });
    provider.start();
    setRunning(true);
    return () => {
      unsubscribe();
      provider.pause();
    };
  }, [provider]);

  return {
    actions,
    running,
    mode: provider.mode,
    moments: provider.moments,
    start: () => {
      provider.start();
      setRunning(true);
    },
    pause: () => {
      provider.pause();
      setRunning(false);
    },
    reset: () => {
      provider.reset();
      setActions([]);
      setRunning(false);
    },
    jumpTo: (id: string) => {
      provider.jumpTo?.(id);
      setActions([...provider.history()].reverse());
      setRunning(true);
    },
    burst: () => {
      (provider as MockProvider).burst?.(4000);
      setRunning(true);
    },
  };
}

export function useMetrics() {
  const provider = useMemo(getProvider, []);
  const [metrics, setMetrics] = useState<BenchmarkMetrics | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    void provider.metrics().then((m) => {
      if (alive) {
        setMetrics(m);
        setLoaded(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [provider]);
  return { metrics, loaded, mode: provider.mode };
}

export function usePolicies() {
  const provider = useMemo(getProvider, []);
  const [policies, setPolicies] = useState<Policy[]>([]);
  // Bumping this refetches. A policy published from the composer has to appear
  // in the same list as every other policy, not in a separate pending state —
  // the whole claim is that it is now live.
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    void provider.policies().then((p) => alive && setPolicies(p));
    return () => {
      alive = false;
    };
  }, [provider, nonce]);
  return { policies, refresh: () => setNonce((n) => n + 1) };
}

/** Measures actual frame rate. Used by the burst test so "60fps" is an observed
 *  number on the machine running the demo, not an assumption. */
export function useFrameRate(active: boolean) {
  const [fps, setFps] = useState(0);
  const frames = useRef(0);
  const last = useRef(0);

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const loop = (t: number) => {
      frames.current += 1;
      if (!last.current) last.current = t;
      if (t - last.current >= 500) {
        setFps(Math.round((frames.current * 1000) / (t - last.current)));
        frames.current = 0;
        last.current = t;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return fps;
}
