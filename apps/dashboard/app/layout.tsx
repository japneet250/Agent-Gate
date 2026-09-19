import type { Metadata } from 'next';
import './globals.css';
import { Nav } from '@/components/shell/nav';
import { Ambient } from '@/components/shell/ambient';

export const metadata: Metadata = {
  title: 'AgentGate — Control Plane',
  description: 'Runtime interception for AI agents: every tool call evaluated before it executes.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Albert+Sans:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        {/* Ambient depth is one fixed layer behind everything — never per-row. */}
        <Ambient />
        <div className="relative z-10 flex min-h-screen flex-col">
          <Nav />
          <main className="flex-1">{children}</main>
        </div>
      </body>
    </html>
  );
}
