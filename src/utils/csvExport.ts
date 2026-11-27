/**
 * A stats time series, as a CSV a spreadsheet will open honestly.
 *
 * Every metrics subsection — a consumer's inbound RTP, a producer's outbound
 * RTP, the remote-outbound view of either — is backed by the same shape: a list
 * of samples, each an object of fields, taken across the session. This flattens
 * that list, and the whole file is about the three ways such a conversion
 * silently loses or corrupts data:
 *
 *   1. **A field that appears late.** Browsers begin reporting some fields only
 *      once they have a value: `framesDecoded` before the first frame arrives,
 *      `qualityLimitationReason` before the encoder is under pressure. Reading
 *      the columns off the first row alone drops those from the export
 *      entirely — the file looks complete and is not. The header is the union
 *      of every key in every row.
 *   2. **Cell boundaries.** A candidate address, a codec's `sdpFmtpLine` or an
 *      ICE URL can carry commas, semicolons, quotes, tabs and line breaks, and
 *      the text does not only meet readers that follow RFC 4180: a clipboard
 *      paste is split on TAB and line breaks, and a spreadsheet in many locales
 *      splits a `.csv` on `;`. So tabs and line breaks are taken out of the
 *      text altogether, and commas, semicolons and quotes are quoted.
 *   3. **Formula injection.** Text beginning `=`, `+`, `-` or `@` is executed
 *      as a formula by Excel, LibreOffice and Sheets. Every field name and
 *      value in a sample is chosen by the browser that sent it, so all text is
 *      defused, headers included. Genuine numbers are left exactly as they
 *      are: a negative reading keeps its sign.
 *
 * Points 2 and 3 live in one function, `escapeCsvValue`, and every cell of
 * every CSV this app produces goes through it — including the ones written by
 * `metricSeriesExport.ts`, which builds the *compact* clipboard CSV: one column
 * per charted metric, `t` in seconds, and a title line above the header. The
 * two shapes stay separate. That one is for pasting a chart into a message.
 * This one is for analysis, so it carries every field the browser reported and
 * real timestamps, and its first line is the column header with nothing above
 * it — a title line would land in a spreadsheet as row 1 and push every column
 * name into the data.
 */

/** A single sample: one row of the export. */
export type CsvRow = Record<string, unknown>;

export interface ToCsvOptions {
  /**
   * Columns to place first, in this order, when present. The rest follow in
   * first-seen order, so the file opens on the fields a reader is looking for
   * without hiding any of the others.
   */
  leadingColumns?: string[];
  /**
   * Field holding an epoch-ms timestamp. When present, an ISO-8601 column is
   * inserted beside it: the raw number is what you sort and subtract on, the
   * ISO string is what you read.
   */
  timestampField?: string;
  /** Name for the derived ISO column. */
  isoColumnName?: string;
}

const DEFAULT_TIMESTAMP_FIELD = 'timestamp';
const DEFAULT_ISO_COLUMN = 'timestampIso';

/**
 * Every key in every row, in first-seen order.
 *
 * The union, not the first row's keys — see note 1 above. This is the single
 * most important function in the file.
 */
function collectColumns(rows: CsvRow[]): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }
  return columns;
}

/** Reorder so `leading` comes first, in the order given. */
function applyColumnOrder(columns: string[], leading: string[] | undefined): string[] {
  if (!leading?.length) return columns;
  const wanted = leading.filter((c) => columns.includes(c));
  const rest = columns.filter((c) => !wanted.includes(c));
  return [...wanted, ...rest];
}

/**
 * Render one non-numeric value as text, before it is made safe.
 *
 * `null` and `undefined` both become empty rather than the strings "null" and
 * "undefined": a missing reading is missing, and a spreadsheet will not average
 * an empty cell into a column.
 */
function renderText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  try {
    // `undefined` for what JSON cannot express (a function, a symbol).
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Anything that ends a cell or a row for some reader: TAB, CR, LF and the rest
 * of C0, DEL, C1 (NEL among them) and the Unicode line and paragraph
 * separators.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_RUN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/**
 * What may sit in front of a formula without stopping a spreadsheet from
 * seeing it: whitespace and zero-width characters, which some importers trim,
 * and a double quote, which an importer consumes as the opening of a quoted
 * cell.
 */
const SKIPPED = '[\\s"\\u200b-\\u200d\\u2060]*';

/** `=`, `+`, `-`, `@`, and the full-width forms East Asian locales accept. */
const TRIGGER = '[=+\\-@\\uff1d\\uff0b\\uff0d\\uff20]';

const FORMULA_AT_START = new RegExp(`^${SKIPPED}${TRIGGER}`);
const FORMULA_AFTER_SEMICOLON = new RegExp(`;(?=${SKIPPED}${TRIGGER})`, 'g');

/**
 * One cell, safe to hand to a spreadsheet. The only place in the app that
 * decides how a value becomes CSV text: data cells, header cells and title
 * lines all come through here.
 *
 * A finite `number` is written as it is. Everything else is text, and text is
 * made to hold for a reader that splits on commas, on semicolons or on tabs:
 *
 *   - Control characters become a space. Quoting does not protect a TAB or a
 *     line break from a clipboard paste, so they cannot stay.
 *   - Text a spreadsheet would run gets a leading apostrophe. Excel,
 *     LibreOffice and Sheets all take the cell as text then — some show the
 *     apostrophe and some hide it — and the value stays readable in a
 *     plain-text diff. The check looks past leading whitespace because some
 *     importers trim it first.
 *   - A `;` cannot be removed (an `sdpFmtpLine` is full of them) and quoting
 *     only hides it from a reader that recognises the quotes — a spreadsheet
 *     honours them at the start of a cell only, and in a semicolon locale a
 *     cell starts at the last `;`, not at the last comma. So the piece after a
 *     `;` gets the apostrophe too when it would run.
 *   - RFC 4180 quoting for commas, semicolons, quotes and outer whitespace.
 *
 * What this cannot do is defuse a number: a row whose *first* cell is a
 * negative number begins with `-`, and a reader that takes the whole line as
 * one cell sees that sign first.
 */
export function escapeCsvValue(value: unknown): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';

  let text = renderText(value).replace(CONTROL_RUN, ' ');
  if (text === '') return '';

  text = text.replace(FORMULA_AFTER_SEMICOLON, ";'");
  if (FORMULA_AT_START.test(text)) text = `'${text}`;

  const mustQuote = /[,;"]/.test(text) || text !== text.trim();

  return mustQuote ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One line of cells, comma-separated, each through `escapeCsvValue`. */
export function toCsvLine(values: unknown[]): string {
  return values.map(escapeCsvValue).join(',');
}

/**
 * Epoch ms, a `Date`, or an ISO string in — ISO string out.
 *
 * Anything unreadable yields an empty cell rather than "Invalid Date", which
 * would sort and filter as text among real timestamps.
 */
function toIso(value: unknown): string {
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Date.parse(value)
          : NaN;
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toISOString();
  } catch {
    return '';
  }
}

/**
 * Serialize samples to CSV.
 *
 * Returns an empty string for no rows, so a caller can tell "nothing to export"
 * from "a file of headers with no data" and decline to offer the download at
 * all.
 *
 * Lines end `\r\n`, which RFC 4180 requires and Excel on Windows needs to keep
 * rows apart; every other reader accepts it.
 */
export function toCsv(rows: CsvRow[] | null | undefined, options: ToCsvOptions = {}): string {
  if (!rows?.length) return '';

  const timestampField = options.timestampField ?? DEFAULT_TIMESTAMP_FIELD;
  const isoColumnName = options.isoColumnName ?? DEFAULT_ISO_COLUMN;

  const raw = collectColumns(rows);
  if (raw.length === 0) return '';

  const hasTimestamp = raw.includes(timestampField);
  const columns = applyColumnOrder(
    raw,
    options.leadingColumns ?? (hasTimestamp ? [timestampField] : undefined),
  );

  // The ISO column rides immediately after the raw timestamp it describes.
  const header: string[] = [];
  for (const column of columns) {
    header.push(column);
    if (hasTimestamp && column === timestampField) header.push(isoColumnName);
  }

  const lines: string[] = [toCsvLine(header)];

  for (const row of rows) {
    const cells: unknown[] = [];
    for (const column of columns) {
      const value = row?.[column];
      cells.push(value);
      if (hasTimestamp && column === timestampField) cells.push(toIso(value));
    }
    lines.push(toCsvLine(cells));
  }

  return lines.join('\r\n');
}
