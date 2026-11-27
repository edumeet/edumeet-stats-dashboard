/**
 * Shared helpers for converting time-series arrays to MiniChart data format.
 */

import { html, joinHtml, type SafeHtml } from './safeHtml.ts';

export interface MiniChartDataPoint {
  timestamp: Date;
  value: number;
}

export function toMiniChartData<T extends { timestamp: Date | number }>(
  values: T[],
  field: keyof T,
): MiniChartDataPoint[] {
  return values
    .map((v) => ({
      timestamp: v.timestamp instanceof Date ? v.timestamp : new Date(v.timestamp as number),
      value: typeof v[field] === 'number' ? (v[field] as number) : NaN,
    }))
    .filter((d) => Number.isFinite(d.value));
}

/** Returns true if the series has at least 2 non-zero values. */
export function hasEnoughData(data: MiniChartDataPoint[]): boolean {
  return data.filter((d) => d.value !== 0).length >= 2;
}

/**
 * Extract the first non-empty `attachments` record from a time-series values array.
 * The raw stats object is spread into each value, so attachments live at the top level
 * even though they are not in the typed interface.
 */
export function extractValuesAttachments(
  values: unknown[],
): Record<string, unknown> | null {
  for (const v of values) {
    const a = (v as Record<string, unknown>)['attachments'];
    if (a && typeof a === 'object' && !Array.isArray(a)) {
      const rec = a as Record<string, unknown>;
      if (Object.keys(rec).some((k) => rec[k] != null)) return rec;
    }
  }
  return null;
}

/** One series under the crosshair. `value` is the formatter's output, whatever it returned. */
export interface MiniChartReading {
  label: unknown;
  color: unknown;
  value: unknown;
}

/**
 * The crosshair tooltip of a MiniChart.
 *
 * Built here rather than inside the component so it can be tested without a
 * DOM. Nothing a caller passes is taken as markup: a series label can carry a
 * client-chosen id, a formatter can return anything, and notes are the
 * client's free text. Only `regionTip` is markup, and its type says who made it.
 */
export function miniChartTooltip({
  readings,
  notes,
  time,
  regionTip,
  noteClass,
}: {
  readings: readonly MiniChartReading[];
  /** Point notes of every series; blanks and repeats are dropped here. */
  notes: readonly unknown[];
  time: string;
  /** Issue details for the shaded region under the cursor, shown instead of the time. */
  regionTip?: SafeHtml;
  noteClass: string;
}): SafeHtml {
  const valueLines = joinHtml(
    readings.map((r) => html`<span style="color:${r.color}">${r.label}: <strong>${r.value}</strong></span>`),
  );
  // Point notes (score reasons) are per-series; de-duplicate so a reason
  // shared across series is not repeated.
  const noteLines = [
    ...new Set(notes.filter((n): n is string => typeof n === 'string' && n.trim() !== '')),
  ].map((n) => html`<span class="${noteClass}">${n}</span>`);

  const base = regionTip
    ? html`${regionTip}${readings.length > 0 ? html`<br/>${valueLines}` : null}`
    : html`${valueLines}<br/><span style="color:var(--text-muted)">${time}</span>`;
  return noteLines.length > 0 ? html`${base}<br/>${noteLines}` : base;
}
