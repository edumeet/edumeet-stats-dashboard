import type { ChartDataResult } from './chartHelpers.ts';
import { escapeCsvValue, toCsvLine } from './csvExport.ts';

export interface ExportMetricColumn {
  key: string;
  data: Array<{ timestamp: Date; value: number }>;
  series?: Array<{ key: string; data: Array<{ timestamp: Date; value: number }> }>;
}

export function titleToMetricKey(title: string): string {
  const slug = title
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'metric';
}

export function chartResultsToColumns(charts: ChartDataResult[], keyPrefix = ''): ExportMetricColumn[] {
  return charts.map((c) => ({
    key: `${keyPrefix}${titleToMetricKey(c.title)}`,
    data: c.data,
  }));
}

export function pointSeriesToColumns(
  entries: Array<{ key: string; data: Array<{ timestamp: Date; value: number }> }>,
): ExportMetricColumn[] {
  return entries
    .filter((e) => e.data.length >= 2)
    .map((e) => ({ key: e.key, data: e.data }));
}

/**
 * Compact wide CSV: one row per snapshot, `t` = seconds from first sample.
 *
 * The title and the column keys can carry text taken from a sample (a stream
 * key, a series name), so they are cells like any other and go through the
 * same routine as the values: the title line is exactly one cell.
 */
export function metricGroupToCsv(
  sectionTitle: string,
  columns: ExportMetricColumn[],
  suffix = 'time series',
): string {
  type Col = { key: string; values: Map<number, number> };
  const cols: Col[] = [];
  const timestamps = new Set<number>();

  for (const col of columns) {
    if (col.series?.length) {
      for (const s of col.series) {
        const values = new Map<number, number>();
        for (const pt of s.data) {
          const ms = pt.timestamp.getTime();
          timestamps.add(ms);
          values.set(ms, pt.value);
        }
        cols.push({ key: s.key, values });
      }
    } else {
      const values = new Map<number, number>();
      for (const pt of col.data) {
        const ms = pt.timestamp.getTime();
        timestamps.add(ms);
        values.set(ms, pt.value);
      }
      cols.push({ key: col.key, values });
    }
  }

  if (cols.length === 0 || timestamps.size === 0) return '';

  const sortedMs = [...timestamps].sort((a, b) => a - b);
  const t0 = sortedMs[0];
  const lines = [
    escapeCsvValue(`${sectionTitle} (${suffix})`),
    toCsvLine(['t', ...cols.map((c) => c.key)]),
  ];

  for (const ms of sortedMs) {
    const tSec = Math.round((ms - t0) / 1000);
    lines.push(toCsvLine([tSec, ...cols.map((c) => c.values.get(ms))]));
  }

  return lines.join('\n');
}

export function buildMetricCsv(
  sectionTitle: string,
  columns: ExportMetricColumn[],
  suffix?: string,
): string | null {
  const csv = metricGroupToCsv(sectionTitle, columns, suffix);
  return csv || null;
}
