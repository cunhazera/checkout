import { artFor } from '../data/presentation';

/**
 * The tinted art box. The design handoff is explicit that these glyphs stand in
 * for real product photography — when photos land they drop into this same box
 * at the same radius, wrapped in the design system's `.washed` class.
 */
export function Art({ itemId, className }: { itemId: string; className: string }) {
  const art = artFor(itemId);
  return (
    <div className={`${className} tp-art-${art.palette}`}>
      <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
        <path d={art.p1} />
        <path d={art.p2} />
      </svg>
    </div>
  );
}
