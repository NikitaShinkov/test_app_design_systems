import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useGlyphFit } from './useGlyphFit';

/** Logo height; the product name's capital letters are fitted to it. */
export const LOGO_HEIGHT = 32;
/** Maximum width of a one-line product name. */
export const NAME_MAX_WIDTH = 160;
/** Two-line names: line spacing as a fraction of the font's natural (`normal`) line height. */
export const TWO_LINE_SPACING = 0.85;

export type NameMode = 'regular' | 'two-lines' | 'fit-width';

const WEIGHT: Record<NameMode, number> = { regular: 400, 'two-lines': 600, 'fit-width': 500 };

/** Split into two lines at the word break that makes the longer line as short as possible. */
function splitInTwo(words: string[], measure: (s: string) => number): [string, string] {
  let best: [string, string] = [words[0], words.slice(1).join(' ')];
  let bestW = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
    const w = Math.max(measure(a), measure(b));
    if (w < bestW) [best, bestW] = [[a, b], w];
  }
  return best;
}

/**
 * Product-name layout next to the logo (the standard algorithm, see REDESIGN_SKILL_GUIDE.md):
 *  1. Regular Italic with capital-letter height = logo height (32px). If the text is ≤ 160px wide → one line.
 *  2. Otherwise, 2+ words → two lines (balanced word split), Semi Bold Italic, first-line cap top on the logo top,
 *     last-line baseline on the logo bottom (line spacing 0.85 × normal).
 *  3. Otherwise (one word) → Medium Italic, font size so the text is exactly 160px wide (cap band centred on the logo).
 * Measures the real font (canvas, after the web font loads), so the decision follows the actual glyph widths.
 */
export function useProductNameFit(name: string, family: string): { lines: string[]; style: CSSProperties; mode: NameMode } {
  const [fontsVersion, setFontsVersion] = useState(0);
  useEffect(() => {
    if (typeof document === 'undefined' || !document.fonts) return;
    let alive = true;
    Promise.all([400, 500, 600].map((w) => document.fonts.load(`italic ${w} 100px ${family}`)))
      .then(() => alive && setFontsVersion((v) => v + 1))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [family]);

  const decision = useMemo(() => {
    const words = name.trim().split(/\s+/);
    const ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    if (!ctx) return { mode: 'regular' as NameMode, lines: [name] };
    const measureAt = (weight: number) => {
      ctx.font = `italic ${weight} 100px ${family}`;
      const capRatio = ctx.measureText('H').actualBoundingBoxAscent / 100;
      const size = LOGO_HEIGHT / capRatio; // font size whose capitals are 32px tall
      return (s: string) => {
        ctx.font = `italic ${weight} 100px ${family}`;
        return (ctx.measureText(s).width / 100) * size;
      };
    };
    if (measureAt(400)(name) <= NAME_MAX_WIDTH) return { mode: 'regular' as NameMode, lines: [name] };
    if (words.length >= 2) return { mode: 'two-lines' as NameMode, lines: splitInTwo(words, measureAt(600)) };
    return { mode: 'fit-width' as NameMode, lines: [name] };
    // fontsVersion: re-decide once the italic faces have loaded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, family, fontsVersion]);

  const style = useGlyphFit(
    LOGO_HEIGHT,
    { family, style: 'italic', weight: WEIGHT[decision.mode] },
    decision.mode === 'two-lines'
      ? { lines: 2, lineHeight: TWO_LINE_SPACING }
      : decision.mode === 'fit-width'
        ? { width: NAME_MAX_WIDTH, text: name }
        : {},
  );

  return { lines: decision.lines, style, mode: decision.mode };
}
