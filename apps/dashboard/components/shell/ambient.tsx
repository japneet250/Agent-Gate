/**
 * The ambient background.
 *
 * Fixed, pointer-events-none, and behind everything. It animates slowly and is
 * composited on its own layer, so it costs one GPU layer for the whole page
 * rather than a blur per row. This is the "spatial depth" half of the brief;
 * the feed above it stays flat and opaque on purpose.
 */
export function Ambient() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <div
        className="absolute -left-[18%] -top-[22%] h-[52rem] w-[52rem] animate-drift rounded-full opacity-60 blur-[120px]"
        style={{ background: 'radial-gradient(circle, rgba(91,140,255,0.16), transparent 62%)' }}
      />
      <div
        className="absolute -right-[14%] top-[6%] h-[42rem] w-[42rem] animate-drift rounded-full opacity-50 blur-[110px]"
        style={{ background: 'radial-gradient(circle, rgba(255,77,100,0.12), transparent 62%)', animationDelay: '-9s' }}
      />
      <div
        className="absolute bottom-[-20%] left-[34%] h-[38rem] w-[38rem] animate-drift rounded-full opacity-40 blur-[110px]"
        style={{ background: 'radial-gradient(circle, rgba(61,220,151,0.11), transparent 62%)', animationDelay: '-17s' }}
      />
      {/* Fine grid, very low contrast — reads as "instrument", not decoration. */}
      <div
        className="absolute inset-0 opacity-[0.16]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.045) 1px, transparent 1px)',
          backgroundSize: '56px 56px',
          maskImage: 'radial-gradient(ellipse 80% 60% at 50% 0%, #000 40%, transparent 100%)',
          WebkitMaskImage: 'radial-gradient(ellipse 80% 60% at 50% 0%, #000 40%, transparent 100%)',
        }}
      />
    </div>
  );
}
