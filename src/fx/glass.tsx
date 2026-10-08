import type { JSX, ReactNode } from 'react';

// Finch 1.4.1: the glass look without the cost. finch-remote's GlassPanel ran
// a 22px backdrop-filter blur plus an SVG turbulence filter over whatever
// was behind it, which the Car Thing re-renders every frame something moves
// underneath (lyrics, the seek bar, a sheet sliding). This keeps the same
// tinted gradient, hairline border and specular streak as a plain, nearly
// opaque surface: identical layout, no filters.
export function GlassPanel({ className, children }: { className?: string; children: ReactNode }): JSX.Element {
  return (
    <div
      className={className}
      style={{
        position: 'relative',
        overflow: 'hidden',
        background:
          'linear-gradient(160deg, rgba(58,58,66,.96), rgba(30,30,36,.97) 40%, rgba(44,44,52,.96))',
        border: '1px solid rgba(255,255,255,.14)',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background: 'linear-gradient(115deg, transparent 30%, rgba(255,255,255,.07) 45%, transparent 60%)',
        }}
      />
      {children}
    </div>
  );
}
