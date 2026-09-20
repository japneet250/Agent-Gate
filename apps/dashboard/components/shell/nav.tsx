'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, BarChart3, ShieldCheck, Inbox, Scale, Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { configuredMode } from '@/lib/data';
import { ModeBadge } from './mode-badge';

const LINKS = [
  // Live leads: it is where a demo starts, and where a visitor should land.
  { href: '/live', label: 'Live', icon: Terminal },
  { href: '/', label: 'Shield', icon: Activity },
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/review', label: 'Review', icon: Inbox },
  { href: '/policies', label: 'Policies', icon: Scale },
];

export function Nav() {
  const pathname = usePathname();
  const mode = configuredMode();

  return (
    // Static chrome -> glass is correct here. Nothing live-updating sits on it.
    <header className="glass glass-edge sticky top-0 z-40 border-x-0 border-t-0">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-6 px-5">
        <Link href="/" className="flex items-center gap-2.5 rounded-field focus-visible:ring-focus">
          <span className="grid h-7 w-7 place-items-center rounded-field bg-accent/15 ring-1 ring-accent/30">
            <ShieldCheck className="h-4 w-4 text-accent" strokeWidth={2.2} />
          </span>
          <span className="text-[0.95rem] font-semibold tracking-tight">AgentGate</span>
        </Link>

        <nav className="flex items-center gap-1">
          {LINKS.map(({ href, label, icon: Icon }) => {
            const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  'flex items-center gap-1.5 rounded-field px-2.5 py-1.5 text-body transition-colors duration-150',
                  active ? 'bg-white/[0.07] text-paper' : 'text-muted hover:bg-white/[0.04] hover:text-paper',
                )}
              >
                <Icon className="h-3.5 w-3.5" strokeWidth={2} />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <Link
            href="/present"
            className="rounded-field border border-white/10 px-2.5 py-1.5 text-body text-muted transition-colors hover:border-white/20 hover:text-paper"
          >
            Presenter
          </Link>
          <ModeBadge mode={mode} />
        </div>
      </div>
    </header>
  );
}
