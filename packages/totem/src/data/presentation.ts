/**
 * Presentation-only metadata for catalog items: the art palette and the glyph
 * drawn in the tinted box. The design handoff is explicit that these glyphs are
 * placeholders for real product photography, and the API has no column for
 * them — art direction does not belong in the stock database.
 *
 * Keyed by the seed's item UUIDs. Anything not listed falls back to a palette
 * derived from the id plus a generic glyph, so adding an item via psql renders
 * sensibly instead of crashing.
 *
 * Glyph path data is lifted verbatim from the design prototype's ITEMS array.
 */

export type ArtPalette = 'accent' | 'sage' | 'sand';

export interface Art {
  palette: ArtPalette;
  p1: string;
  p2: string;
}

const GENERIC: Omit<Art, 'palette'> = {
  p1: 'M5 8.5h14l-1.4 11H6.4L5 8.5z',
  p2: 'M9 5.5h6M4.5 8.5h15',
};

const BY_ID: Record<string, Art> = {
  '11111111-1111-4111-8111-000000000001': {
    palette: 'sand',
    p1: 'M7.5 3h9l1.5 18H6L7.5 3z',
    p2: 'M9.5 8.5h5M9.5 13h5',
  },
  '11111111-1111-4111-8111-000000000002': {
    palette: 'accent',
    p1: 'M6 4h12l-1.2 9.5A5 5 0 0 1 7.2 13.5L6 4z',
    p2: 'M6 4h12M10 17.5h4',
  },
  '11111111-1111-4111-8111-000000000003': {
    palette: 'sage',
    p1: 'M3.5 9h17v6h-17z',
    p2: 'M8 9v6M12 9v6M16 9v6',
  },
  '11111111-1111-4111-8111-000000000004': {
    palette: 'sand',
    p1: 'M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z',
    p2: 'M9.5 10h.01M14 9.5h.01M11 14.5h.01M15 14h.01',
  },
  '11111111-1111-4111-8111-000000000005': {
    palette: 'accent',
    p1: 'M4 9.5l8-4 8 4-8 4-8-4z',
    p2: 'M4 13.5l8 4 8-4',
  },
  '11111111-1111-4111-8111-000000000006': {
    palette: 'sage',
    p1: 'M5 8.5h14l-1.4 11H6.4L5 8.5z',
    p2: 'M9 5.5a3 3 0 0 1 6 0M4.5 8.5h15',
  },
  '11111111-1111-4111-8111-000000000007': {
    palette: 'sage',
    p1: 'M9.5 3.5h5v2.5l2 3v10a2 2 0 0 1-2 2h-5a2 2 0 0 1-2-2v-10l2-3V3.5z',
    p2: 'M7.5 12.5h9',
  },
  '11111111-1111-4111-8111-000000000008': {
    palette: 'accent',
    p1: 'M7.5 4h9v14a2 2 0 0 1-2 2h-5a2 2 0 0 1-2-2V4z',
    p2: 'M7.5 8.5h9M7.5 15h9',
  },
  '11111111-1111-4111-8111-000000000009': {
    palette: 'sand',
    p1: 'M7 7.5h10l-1.4 12H8.4L7 7.5z',
    p2: 'M5 7.5h14M10.5 11v5M13.5 11v5',
  },
};

const PALETTES: ArtPalette[] = ['accent', 'sage', 'sand'];

export function artFor(itemId: string): Art {
  const known = BY_ID[itemId];
  if (known) return known;

  let hash = 0;
  for (const ch of itemId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return { palette: PALETTES[hash % PALETTES.length]!, ...GENERIC };
}
