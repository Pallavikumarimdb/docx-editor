/**
 * Format-change helpers for the fromProseDoc paragraph converter.
 *
 * Provides utilities for converting the compact mark-keyed JSON stored in
 * `formatChange` mark attributes back to `TextFormatting`-shaped objects,
 * and for building the `RunPropertyChange` record attached to format-changed runs.
 */

import type {
  TextFormatting,
  UnderlineStyle,
  ColorValue,
  ThemeColorSlot,
} from '../../../types/document';
import type { RunPropertyChange } from '../../../types/content/trackedChange';
import type { Mark } from 'prosemirror-model';
import type { Run } from '../../../types/document';

/**
 * Convert the compact mark-keyed JSON stored in the `formatChange` mark's
 * `previousFormatting` attribute back to a `TextFormatting`-shaped object.
 *
 * The compact JSON was written by `handlers/formatChange.ts` as:
 *   { bold: true, fontSize: { size: 24, … }, textColor: { rgb: 'FF0000', … }, … }
 *
 * Boolean marks (bold, italic, strike, etc.) are stored as `true`.
 * Marks with attrs are stored as their attrs object.
 *
 * The resulting TextFormatting is passed to `RunPropertyChange.previousFormatting`
 * so the serializer can write the correct `<w:rPrChange>` child element.
 */
export function markJsonToTextFormatting(parsed: Record<string, unknown>): TextFormatting {
  const f: TextFormatting = {};

  if (parsed.bold === true) {
    f.bold = true;
    f.boldCs = true;
  }
  if (parsed.italic === true) {
    f.italic = true;
    f.italicCs = true;
  }
  if (parsed.strike === true) f.strike = true;
  if (parsed.allCaps === true) f.allCaps = true;
  if (parsed.smallCaps === true) f.smallCaps = true;
  if (parsed.emboss === true) f.emboss = true;
  if (parsed.imprint === true) f.imprint = true;
  if (parsed.textShadow === true) f.shadow = true;
  if (parsed.textOutline === true) f.outline = true;
  if (parsed.hidden === true) f.hidden = true;
  if (parsed.rtl === true) f.rtl = true;
  if (parsed.superscript === true) f.vertAlign = 'superscript';
  if (parsed.subscript === true) f.vertAlign = 'subscript';

  if (parsed.underline && typeof parsed.underline === 'object') {
    const u = parsed.underline as { style?: string; color?: unknown };
    f.underline = {
      style: (u.style || 'single') as UnderlineStyle,
      color: u.color as ColorValue | undefined,
    };
  }
  if (parsed.textColor && typeof parsed.textColor === 'object') {
    const c = parsed.textColor as {
      rgb?: string;
      themeColor?: string;
      themeTint?: string;
      themeShade?: string;
    };
    f.color = {
      rgb: c.rgb,
      themeColor: c.themeColor as ThemeColorSlot | undefined,
      themeTint: c.themeTint,
      themeShade: c.themeShade,
    };
  }
  if (parsed.highlight && typeof parsed.highlight === 'object') {
    const h = parsed.highlight as { color?: string };
    if (h.color) f.highlight = h.color as TextFormatting['highlight'];
  }
  if (parsed.fontSize && typeof parsed.fontSize === 'object') {
    const fs = parsed.fontSize as { size?: number };
    if (fs.size != null) f.fontSize = fs.size;
  }
  if (parsed.fontFamily && typeof parsed.fontFamily === 'object') {
    const ff = parsed.fontFamily as {
      ascii?: string;
      hAnsi?: string;
      eastAsia?: string;
      cs?: string;
    };
    f.fontFamily = { ascii: ff.ascii, hAnsi: ff.hAnsi, eastAsia: ff.eastAsia, cs: ff.cs };
  }
  if (parsed.characterSpacing && typeof parsed.characterSpacing === 'object') {
    const cs = parsed.characterSpacing as {
      spacing?: number;
      position?: number;
      scale?: number;
      kerning?: number;
    };
    if (cs.spacing != null) f.spacing = cs.spacing;
    if (cs.position != null) f.position = cs.position;
    if (cs.scale != null) f.scale = cs.scale;
    if (cs.kerning != null) f.kerning = cs.kerning;
  }
  if (parsed.emphasisMark && typeof parsed.emphasisMark === 'object') {
    const em = parsed.emphasisMark as { type?: string };
    if (em.type) f.emphasisMark = em.type as TextFormatting['emphasisMark'];
  }
  if (parsed.textEffect && typeof parsed.textEffect === 'object') {
    const te = parsed.textEffect as { effect?: string };
    if (te.effect) f.effect = te.effect as TextFormatting['effect'];
  }

  return f;
}

/**
 * Build a `RunPropertyChange` record for a run that carries a `formatChange`
 * mark, then flush the run immediately (format-change runs can't coalesce).
 *
 * Returns `true` when the run was flushed (caller should reset `currentRun`
 * and `currentMarksKey` to `null`).
 */
export function attachFormatChangeAndFlush(
  formatChangeMark: Mark,
  run: Run,
  content: unknown[]
): boolean {
  let previousFormatting: TextFormatting | undefined;
  try {
    const raw = formatChangeMark.attrs.previousFormatting as string | null;
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      previousFormatting = markJsonToTextFormatting(parsed);
    }
  } catch {
    // Malformed JSON — treat as no previous formatting.
  }
  const propertyChange: RunPropertyChange = {
    type: 'runPropertyChange',
    info: {
      id: formatChangeMark.attrs.revisionId as number,
      author: (formatChangeMark.attrs.author as string) || 'Unknown',
      date: (formatChangeMark.attrs.date as string) || undefined,
    },
    previousFormatting,
    currentFormatting: run.formatting,
  };
  run.propertyChanges = [propertyChange];
  content.push(run);
  return true;
}
