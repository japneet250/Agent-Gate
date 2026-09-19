'use client';

import { useEffect, useState } from 'react';
import { Radio, FlaskConical } from 'lucide-react';
import { LiveProvider } from '@/lib/data/live-provider';
import { provenance } from '@/lib/data';
import { cn } from '@/lib/utils';

/**
 * The honesty badge.
 *
 * It is always visible, and in mock mode it says so plainly. The failure mode
 * worth engineering against is a dashboard that looks live while replaying
 * fixtures — so this never abbreviates, never fades out, and the tooltip names
 * the exact files the data came from.
 */
export function ModeBadge({ mode }: { mode: 'mock' | 'live' }) {
  const [health, setHealth] = useState<{ gateway: boolean; engine: boolean } | null>(null);

  useEffect(() => {
    if (mode !== 'live') return;
    let alive = true;
    const check = () => void LiveProvider.health().then((h) => alive && setHealth(h));
    check();
    const t = setInterval(check, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [mode]);

  if (mode === 'mock') {
    return (
      <span
        title={`Replayed from ${provenance.scenariosFile} scored by ${provenance.reportFile}. ${provenance.note}`}
        className="pill border border-escalate/35 bg-escalate/10 text-escalate"
      >
        <FlaskConical className="h-3 w-3" strokeWidth={2.4} />
        Mock data
      </span>
    );
  }

  const both = health?.gateway && health?.engine;
  return (
    <span
      title={
        health
          ? `gateway ${health.gateway ? 'up' : 'DOWN'} · engine ${health.engine ? 'up' : 'DOWN'}`
          : 'checking backends…'
      }
      className={cn(
        'pill border',
        both ? 'border-allow/35 bg-allow/10 text-allow' : 'border-block/35 bg-block/10 text-block',
      )}
    >
      <Radio className="h-3 w-3" strokeWidth={2.4} />
      {both ? 'Live' : 'Live — backend down'}
    </span>
  );
}
