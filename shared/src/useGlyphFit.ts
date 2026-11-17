import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';

interface FontSpec {
  family: string;
  style?: 'normal' | 'italic';
  weight?: number | string;
}

interface FitOptions {
  /** Number of text lines in the block (default 1). */
  lines?: number;
  /** Line height as a multiple of the font size (used between lines when `lines > 1`). */
  lineHeight?: number;
}

const supportsTextBox = () =>
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('text-box', 'trim-both cap alphabetic');

/**
 * Sizes text so that its *visible letters* fill a block of exactly `heightPx`:
 * the cap height (flat top of H, R, M…) of the FIRST line touches the top of the block and the
 * alphabetic baseline of the LAST line touches its bottom. Descenders (g, y) and round overshoots (C, O)
 * extend slightly beyond, as in any typeface.
 *
 *   1 line : capHeight            = heightPx
 *   n lines: capHeight + (n−1)·LH = heightPx,  LH = lineHeight × fontSize
 *
 * Measures the real font with canvas `measureText` (re-measured after the web font loads), so it adapts
 * to the font the OS/browser resolves. Returns styles for a block-level element.
 */
export function useGlyphFit(heightPx: number, font: FontSpec, options: FitOptions = {}): CSSProperties {
  const { family, style = 'normal', weight = 400 } = font;
  const { lines = 1, lineHeight: lhRatio = 1.2 } = options;

  // Web fonts load asynchronously; canvas would measure the fallback font until then.
  // Re-measure once the exact face (family + style + weight) is available.
  const [fontVersion, setFontVersion] = useState(0);
  useEffect(() => {
    if (typeof document === 'undefined' || !document.fonts) return;
    let alive = true;
    document.fonts
      .load(`${style} ${weight} 100px ${family}`)
      .then(() => alive && setFontVersion((v) => v + 1))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [family, style, weight]);

  return useMemo(() => {
    const fallback: CSSProperties = { fontSize: heightPx, lineHeight: `${heightPx}px` };
    const ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    if (!ctx) return fallback;

    const base = 100;
    ctx.font = `${style} ${weight} ${base}px ${family}`;
    const m = ctx.measureText('H'); // flat glyph: top = cap height, bottom = baseline
    const capRatio = m.actualBoundingBoxAscent / base;
    if (!capRatio || !m.fontBoundingBoxAscent) return fallback;

    const fontSize = heightPx / (capRatio + (lines - 1) * lhRatio);
    const k = fontSize / base;
    const capHeight = capRatio * fontSize;
    // Font metrics used for the line box; browsers round them to whole pixels during line layout.
    const fontAscent = Math.round(m.fontBoundingBoxAscent * k);
    const fontDescent = Math.round(m.fontBoundingBoxDescent * k);

    const common: CSSProperties = { display: 'block', height: heightPx, fontSize, fontStyle: style, fontWeight: weight };

    if (lines === 1) {
      // Baseline at heightPx: (L − ascent − descent)/2 + ascent = heightPx.
      const lineHeight = 2 * heightPx - fontAscent + fontDescent;
      return {
        ...common,
        lineHeight: `${lineHeight}px`, // fallback positioning
        // Exact positioning: trim the box to cap height (top) and alphabetic baseline (bottom).
        ...({ textBox: 'trim-both cap alphabetic' } as CSSProperties),
      };
    }

    const lineHeight = lhRatio * fontSize;
    if (supportsTextBox()) {
      return { ...common, lineHeight: `${lineHeight}px`, ...({ textBox: 'trim-both cap alphabetic' } as CSSProperties) };
    }
    // Fallback: shift the first line so its cap top sits at the top of the block.
    const firstBaseline = (lineHeight - fontAscent - fontDescent) / 2 + fontAscent;
    return { ...common, lineHeight: `${lineHeight}px`, marginTop: capHeight - firstBaseline };
    // fontVersion: recompute after the web font has loaded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heightPx, family, style, weight, lines, lhRatio, fontVersion]);
}
