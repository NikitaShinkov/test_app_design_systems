import { useMemo } from 'react';
import type { CSSProperties } from 'react';

interface FontSpec {
  family: string;
  style?: 'normal' | 'italic';
  weight?: number | string;
}

/**
 * Sizes upper-case text so that its *visible capital letters* (not the line box) are exactly `heightPx`
 * tall: the cap height (flat tops of H, R, M…) aligns with the top of a `heightPx`-high block and the
 * baseline with its bottom. Round letters (C, O, S) overshoot by a fraction of a pixel, as in any typeface.
 *
 * Measures the real font with canvas `measureText`, so it adapts to whatever font the OS resolves
 * (Segoe UI, SF Pro, Roboto…). Returns styles for a block-level element.
 */
export function useGlyphFit(heightPx: number, font: FontSpec): CSSProperties {
  const { family, style = 'normal', weight = 400 } = font;

  return useMemo(() => {
    const fallback: CSSProperties = { fontSize: heightPx, lineHeight: `${heightPx}px` };
    const ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    if (!ctx) return fallback;

    const base = 100;
    ctx.font = `${style} ${weight} ${base}px ${family}`;
    const m = ctx.measureText('H'); // flat glyph: top = cap height, bottom = baseline
    const capHeight = m.actualBoundingBoxAscent;
    if (!capHeight || !m.fontBoundingBoxAscent) return fallback;

    const k = heightPx / capHeight;
    // Font metrics used for the line box; browsers round them to whole pixels during line layout.
    const fontAscent = Math.round(m.fontBoundingBoxAscent * k);
    const fontDescent = Math.round(m.fontBoundingBoxDescent * k);

    // In a line box of height L the baseline sits at (L − fontAscent − fontDescent)/2 + fontAscent.
    // Put the baseline at heightPx (bottom of the block) so cap tops land at 0 (top of the block).
    const lineHeight = 2 * heightPx - fontAscent + fontDescent;

    return {
      display: 'block',
      height: heightPx,
      fontSize: base * k,
      lineHeight: `${lineHeight}px`,
      fontStyle: style,
      fontWeight: weight,
    };
  }, [heightPx, family, style, weight]);
}
