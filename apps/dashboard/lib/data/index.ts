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

/** One provider per browser session. Swapping mode is a reload, not a hot swap —
 *  a half-live/half-mock feed would be impossible to reason about on stage. */
let singleton: DataProvider | null = null;
export function getProvider(): DataProvider {
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
  const [actions, setActions] = useState<EvaluatedAction[]>(() => [...provider.history()].reverse());
  const [running, setRunning] = useState(false);

  useEffect(() => {
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
  useEffect(() => {
    let alive = true;
    void provider.policies().then((p) => alive && setPolicies(p));
    return () => {
      alive = false;
    };
  }, [provider]);
  return policies;
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
