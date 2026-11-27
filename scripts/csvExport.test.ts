/**
 * Copying a stats subsection to the clipboard as CSV, in both shapes: every
 * field of every sample (`csvExport.ts`) and the compact one-column-per-chart
 * form (`metricSeriesExport.ts`).
 *
 *   node --experimental-strip-types scripts/csvExport.test.ts
 *
 * The three ways this conversion silently ruins data — a field that only shows
 * up in later samples, a value that carries something a reader splits on, and
 * text a spreadsheet executes as a formula — are what most of these checks are
 * about. The last two are checked the way a spreadsheet would meet them: the
 * output is read back as comma-, semicolon- and tab-delimited text.
 */

import assert from 'node:assert/strict';
import { toCsv, toCsvLine, escapeCsvValue } from '../src/utils/csvExport.ts';
import {
  buildMetricCsv,
  metricGroupToCsv,
  type ExportMetricColumn,
} from '../src/utils/metricSeriesExport.ts';

const T0 = 1_700_000_000_000;

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

/** Split a CSV back into rows, for asserting on shape. */
function lines(csv: string): string[] {
  return csv.split('\r\n');
}

const char = (code: number) => String.fromCharCode(code);

/**
 * Read delimited text the way a consumer would.
 *
 * Two conventions for double quotes exist and the output has to hold under
 * both. A spreadsheet honours a quote only where a cell begins — anywhere else
 * it is an ordinary character — and appends whatever follows the closing quote.
 * Simpler readers flip in and out of quoted mode at every quote.
 */
function parseDelimited(text: string, delimiter: string, quotesAnywhere: boolean): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let atCellStart = true;
  const endRow = () => {
    row.push(cell);
    rows.push(row);
    row = [];
    cell = '';
    atCellStart = true;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') {
        cell += ch;
      } else if (text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = false;
      }
    } else if (ch === '"' && (atCellStart || quotesAnywhere)) {
      quoted = true;
      atCellStart = false;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
      atCellStart = true;
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endRow();
    } else {
      cell += ch;
      atCellStart = false;
    }
  }
  endRow();
  return rows;
}

const FULLWIDTH_OPENERS = [0xff1d, 0xff0b, 0xff0d, 0xff20].map(char);
const RUNS = new RegExp(`^[\\s"]*[=+\\-@${FULLWIDTH_OPENERS.join('')}]`);
const NUMBER = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/;

/** Would a spreadsheet take this cell for a formula? A plain number is not one. */
function runs(cell: string): boolean {
  return RUNS.test(cell) && !NUMBER.test(cell);
}

/**
 * The property the exporters promise, checked against all three readings.
 *
 * `widths` is the number of cells written on each line. Read on commas, every
 * line must come back with exactly that many; read on tabs, as one cell (which
 * is what a paste does with a line that has no tab in it); and however it is
 * read, the line count must not move and no cell may start a formula.
 */
function assertHoldsUnderEveryReading(csv: string, widths: number[]) {
  assert.equal(csv.split(/\r\n|\r|\n/).length, widths.length, 'line count');

  for (const quotesAnywhere of [false, true]) {
    const how = quotesAnywhere ? 'quotes anywhere' : 'quotes at cell start';

    const byComma = parseDelimited(csv, ',', quotesAnywhere);
    assert.deepEqual(byComma.map((r) => r.length), widths, `comma reading, ${how}: cells per row`);

    const byTab = parseDelimited(csv, '\t', quotesAnywhere);
    assert.deepEqual(byTab.map((r) => r.length), widths.map(() => 1), `tab reading, ${how}: a cell was split`);

    const bySemicolon = parseDelimited(csv, ';', quotesAnywhere);
    assert.equal(bySemicolon.length, widths.length, `semicolon reading, ${how}: row count`);

    for (const [reading, rows] of [['comma', byComma], ['tab', byTab], ['semicolon', bySemicolon]] as const) {
      for (const row of rows) {
        for (const cell of row) {
          assert.ok(!runs(cell), `${reading} reading, ${how}: ${JSON.stringify(cell)} would run`);
        }
      }
    }
  }

  // Which quote convention the reader follows must not change what it gets.
  assert.deepEqual(parseDelimited(csv, ',', false), parseDelimited(csv, ',', true));
}

/**
 * Text a participant could put in a field name, a value or a stream id: each
 * formula opener, bare, behind whitespace, and behind everything some reader
 * treats as the end of a cell or a row.
 */
const OPENERS = [
  '=1+1', '+1+1', '-1+1', '@SUM(1)', '=HYPERLINK("http://x";"y")',
  ...FULLWIDTH_OPENERS.map((opener) => `${opener}1+1`),
];
const BREAKS = [
  '\t', '\r', '\n', '\r\n', ';', ',', ' ; ', ';"', '",', '\t\t', '\n\n',
  ...[0x00, 0x0b, 0x0c, 0x1f, 0x7f, 0x85, 0x2028, 0x2029].map(char),
];
const HOSTILE: string[] = [];
for (const opener of OPENERS) {
  HOSTILE.push(opener, `  ${opener}`, `"${opener}`);
  for (const brk of BREAKS) {
    HOSTILE.push(
      `${brk}${opener}`,
      `safe${brk}${opener}`,
      `safe${brk}  ${opener}${brk}x`,
      `${opener}${brk}${opener}`,
    );
  }
}

console.log('nothing to copy');

check('no rows yields an empty string, not a lone header', () => {
  // The button uses this to stay inert rather than putting a header row with
  // no data on someone's clipboard.
  assert.equal(toCsv([]), '');
  assert.equal(toCsv(null), '');
  assert.equal(toCsv(undefined), '');
});

check('rows with no fields yield nothing', () => {
  assert.equal(toCsv([{}, {}]), '');
});

console.log('\nthe column union');

check('a field appearing only in a later sample is still a column', () => {
  // The bug this exists to prevent: browsers start reporting some fields only
  // once they have a value, so reading columns off the first row drops them —
  // and the copy looks complete while missing data.
  const csv = toCsv([
    { timestamp: T0, packetsReceived: 10 },
    { timestamp: T0 + 1000, packetsReceived: 25, framesDecoded: 3 },
  ]);
  const [header, first, second] = lines(csv);
  assert.equal(header, 'timestamp,timestampIso,packetsReceived,framesDecoded');
  // The row that predates the field gets an empty cell, not a zero.
  assert.ok(first.endsWith(',10,'), first);
  assert.ok(second.endsWith(',25,3'), second);
});

check('columns keep first-seen order', () => {
  assert.equal(lines(toCsv([{ b: 1, a: 2 }, { c: 3 }]))[0], 'b,a,c');
});

check('the timestamp leads and carries an ISO column beside it', () => {
  const [header, row] = lines(toCsv([{ jitter: 0.01, timestamp: T0 }]));
  assert.equal(header, 'timestamp,timestampIso,jitter');
  assert.equal(row, `${T0},2023-11-14T22:13:20.000Z,0.01`);
});

check('explicit leading columns win over the timestamp default', () => {
  const csv = toCsv([{ a: 1, ssrc: 42, timestamp: T0 }], { leadingColumns: ['ssrc', 'timestamp'] });
  assert.equal(lines(csv)[0], 'ssrc,timestamp,timestampIso,a');
});

check('a leading column that does not exist is skipped, not emitted empty', () => {
  assert.equal(lines(toCsv([{ a: 1 }], { leadingColumns: ['nope', 'a'] }))[0], 'a');
});

console.log('\nquoting');

check('commas, quotes and outer whitespace follow RFC 4180', () => {
  assert.equal(escapeCsvValue('a,b'), '"a,b"');
  assert.equal(escapeCsvValue('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCsvValue('trailing '), '"trailing "');
  assert.equal(escapeCsvValue(' leading'), '" leading"');
});

check('a semicolon is quoted too', () => {
  // Spreadsheets in many locales split a .csv on `;`, not on `,`.
  assert.equal(escapeCsvValue('a;b'), '"a;b"');
  // And an honest value full of them comes through as it was.
  assert.equal(
    escapeCsvValue('level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f'),
    '"level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"',
  );
});

check('tabs and line breaks do not survive inside a value', () => {
  // Quoting cannot be relied on here: a paste splits on TAB and on line breaks
  // whatever the quotes say. A run of them collapses to one space.
  assert.equal(escapeCsvValue('one\ntwo'), 'one two');
  assert.equal(escapeCsvValue('one\r\ntwo'), 'one two');
  assert.equal(escapeCsvValue('one\ttwo'), 'one two');
  assert.equal(escapeCsvValue('one\rtwo'), 'one two');
  assert.equal(escapeCsvValue('one\n'), '"one "');
  for (const code of [0x00, 0x0b, 0x0c, 0x1f, 0x7f, 0x85, 0x2028, 0x2029]) {
    assert.equal(escapeCsvValue(`one${char(code)}two`), 'one two', `U+${code.toString(16)}`);
  }
});

check('a candidate URL with a comma survives the round trip', () => {
  const csv = toCsv([{ timestamp: T0, url: 'turn:1.2.3.4:3478?transport=udp,tcp' }]);
  assert.ok(lines(csv)[1].includes('"turn:1.2.3.4:3478?transport=udp,tcp"'));
});

check('plain values are not quoted needlessly', () => {
  assert.equal(escapeCsvValue('opus'), 'opus');
  assert.equal(escapeCsvValue(42), '42');
});

check('a whole line is its cells, comma-joined', () => {
  assert.equal(toCsvLine(['a,b', 1, null, 'c']), '"a,b",1,,c');
});

console.log('\nvalues');

check('a missing reading is empty, never the word null', () => {
  assert.equal(lines(toCsv([{ timestamp: T0, jitter: null, rtt: undefined }]))[1],
    `${T0},2023-11-14T22:13:20.000Z,,`);
});

check('booleans read as words, not 0 and 1', () => {
  assert.equal(escapeCsvValue(true), 'true');
  assert.equal(escapeCsvValue(false), 'false');
});

check('NaN and Infinity become empty rather than poisoning a column', () => {
  // Empty is also the one rendering no spreadsheet can read anything into.
  assert.equal(escapeCsvValue(NaN), '');
  assert.equal(escapeCsvValue(Infinity), '');
  assert.equal(escapeCsvValue(-Infinity), '');
});

check('numbers are written exactly as they are', () => {
  assert.equal(escapeCsvValue(0), '0');
  assert.equal(escapeCsvValue(42), '42');
  assert.equal(escapeCsvValue(0.125), '0.125');
  assert.equal(escapeCsvValue(-7), '-7');
  assert.equal(escapeCsvValue(-0.001), '-0.001');
  assert.equal(escapeCsvValue(1e21), '1e+21');
  assert.equal(escapeCsvValue(-1.5e-7), '-1.5e-7');
  assert.equal(lines(toCsv([{ a: 3, b: -42, c: 0, d: -0.5, e: 1.25 }]))[1], '3,-42,0,-0.5,1.25');
});

check('a nested object is JSON, not [object Object]', () => {
  assert.equal(escapeCsvValue({ a: 1 }), '"{""a"":1}"');
  assert.equal(escapeCsvValue([1, -2, 'x']), '"[1,-2,""x""]"');
});

check('a Date renders as ISO, and an unreadable one as nothing', () => {
  assert.equal(escapeCsvValue(new Date(T0)), '2023-11-14T22:13:20.000Z');
  assert.equal(escapeCsvValue(new Date(NaN)), '');
});

console.log('\nformula injection');

check('text a spreadsheet would execute is defused', () => {
  // Excel, LibreOffice and Sheets run these. Behind an apostrophe they are text.
  assert.equal(escapeCsvValue('=1+1'), "'=1+1");
  assert.equal(escapeCsvValue('+1+1'), "'+1+1");
  assert.equal(escapeCsvValue('-1+1'), "'-1+1");
  assert.equal(escapeCsvValue('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(escapeCsvValue('+HYPERLINK("http://x")'), '"\'+HYPERLINK(""http://x"")"');
});

check('leading whitespace does not hide a formula', () => {
  // Some importers trim before they decide what a cell is.
  for (const opener of ['=1+1', '+1+1', '-1+1', '@SUM(A1)']) {
    assert.equal(escapeCsvValue(`  ${opener}`), `'  ${opener}`);
    // A leading TAB, CR or LF is whitespace by the time the guard looks.
    assert.equal(escapeCsvValue(`\t${opener}`), `' ${opener}`);
    assert.equal(escapeCsvValue(`\r${opener}`), `' ${opener}`);
    assert.equal(escapeCsvValue(`\r\n${opener}`), `' ${opener}`);
    // Neither does a no-break space or a zero-width one.
    for (const blank of [char(0xa0), char(0x200b), char(0xfeff)]) {
      assert.equal(escapeCsvValue(`${blank}${opener}`), `'${blank}${opener}`);
    }
  }
});

check('a negative number is a number, a string that looks like one is text', () => {
  // Why the guard tests the type and not just the leading character: blanket
  // escaping a leading `-` would mangle every negative reading. A *string*
  // gets no such trust, whatever it looks like.
  assert.equal(escapeCsvValue(-42), '-42');
  assert.equal(escapeCsvValue(-0.001), '-0.001');
  assert.equal(escapeCsvValue('-42'), "'-42");
  assert.equal(escapeCsvValue('+47 123'), "'+47 123");
});

check('a formula cannot start a cell of its own from inside a value', () => {
  for (const opener of ['=1+1', '+1+1', '-1+1', '@SUM(A1)']) {
    // Behind a TAB or a line break it is simply the middle of the text now.
    assert.equal(escapeCsvValue(`safe\t${opener}`), `safe ${opener}`);
    assert.equal(escapeCsvValue(`safe\n${opener}`), `safe ${opener}`);
    assert.equal(escapeCsvValue(`safe\r\n${opener}`), `safe ${opener}`);
    // A `;` stays, so what follows it is defused where it stands: a
    // spreadsheet that splits on `;` ignores quotes in the middle of a cell.
    assert.equal(escapeCsvValue(`safe;${opener}`), `"safe;'${opener}"`);
    assert.equal(escapeCsvValue(`safe; ${opener};x`), `"safe;' ${opener};x"`);
  }
  assert.equal(escapeCsvValue('a;"=1+1;b'), '"a;\'""=1+1;b"');
});

check('header names get the same treatment as values', () => {
  // A column name is a field name from a sample, which is no more trustworthy
  // than the value under it.
  const csv = toCsv([{ '=1+1': 1, '-x': 2, 'a\t@b': 3, 'c;+d': 4, 'e,f': 5 }]);
  assert.equal(lines(csv)[0], `'=1+1,'-x,a @b,"c;'+d","e,f"`);
  assert.equal(lines(csv)[1], '1,2,3,4,5');
});

console.log('\nread back as a spreadsheet would');

check('the reader used below does catch an unguarded cell', () => {
  // Each of these is what an exporter without the guard would have written.
  assert.throws(() => assertHoldsUnderEveryReading('a,=1+1', [2]));
  assert.throws(() => assertHoldsUnderEveryReading('a,-1+1', [2]));
  assert.throws(() => assertHoldsUnderEveryReading('a,"safe\t=1+1"', [2]));
  assert.throws(() => assertHoldsUnderEveryReading('a,"safe\n=1+1"', [2]));
  assert.throws(() => assertHoldsUnderEveryReading('a,"safe;=1+1;x"', [2]));
  assert.throws(() => assertHoldsUnderEveryReading('title\n=1+1\nt,a\n0,1', [1, 2, 2]));
  assertHoldsUnderEveryReading('a,-1,"b;c"', [3]);
});

check('hostile values hold under comma, semicolon and tab readings', () => {
  const rows = HOSTILE.map((text, i) => ({
    timestamp: T0 + i,
    lost: -5,
    drift: -0.25,
    zero: 0,
    text,
    again: text,
    nested: { text, list: [-1, text] },
  }));
  const csv = toCsv(rows);
  assertHoldsUnderEveryReading(csv, [8, ...rows.map(() => 8)]);

  // And the numbers came through untouched, in every row.
  for (const row of parseDelimited(csv, ',', false).slice(1)) {
    assert.deepEqual(row.slice(2, 5), ['-5', '-0.25', '0']);
  }
});

check('hostile field names hold under comma, semicolon and tab readings', () => {
  const row: Record<string, unknown> = { timestamp: T0 };
  HOSTILE.forEach((name, i) => {
    row[name] = i % 2 ? -i : name;
  });
  const csv = toCsv([row, row]);
  const width = Object.keys(row).length + 1;
  assertHoldsUnderEveryReading(csv, [width, width, width]);
});

check('a hostile timestamp column and ISO column name hold too', () => {
  const csv = toCsv(
    [{ 'when\t=1+1': '=2+2', other: '-1' }, { 'when\t=1+1': T0, other: 1 }],
    { timestampField: 'when\t=1+1', isoColumnName: '@iso;=3+3' },
  );
  assertHoldsUnderEveryReading(csv, [3, 3, 3]);
});

console.log('\nthe compact metric CSV');

const at = (seconds: number) => new Date(T0 + seconds * 1000);
const COLUMNS: ExportMetricColumn[] = [
  { key: 'Bitrate_kbps', data: [{ timestamp: at(0), value: 100 }, { timestamp: at(1), value: -3.5 }] },
  { key: 'Jitter_ms', data: [{ timestamp: at(1), value: 0 }] },
];

check('an ordinary section reads as it always did', () => {
  assert.equal(
    metricGroupToCsv('Outbound video', COLUMNS),
    ['Outbound video (time series)', 't,Bitrate_kbps,Jitter_ms', '0,100,', '1,-3.5,0'].join('\n'),
  );
});

check('nothing charted yields nothing to copy', () => {
  assert.equal(metricGroupToCsv('Empty', []), '');
  assert.equal(buildMetricCsv('Empty', []), null);
});

check('the title line is one cell, whatever the stream is called', () => {
  // The title carries a stream key, and a stream key is whatever the sending
  // browser said it was.
  const out = metricGroupToCsv('Unmatched RTP x\n=1+1,\t@SUM(1);-2', COLUMNS).split('\n');
  assert.equal(out.length, 4);
  assert.equal(out[0], `"Unmatched RTP x =1+1, @SUM(1);'-2 (time series)"`);
  assert.equal(metricGroupToCsv('=1+1', COLUMNS).split('\n')[0], "'=1+1 (time series)");
});

check('column and series keys are cells like any other', () => {
  const csv = metricGroupToCsv('Section', [
    { key: '=cmd', data: [{ timestamp: at(0), value: 1 }] },
    {
      key: 'unused when series are given',
      data: [],
      series: [
        { key: '-layer', data: [{ timestamp: at(0), value: -2 }] },
        { key: 'a\t+b,c', data: [{ timestamp: at(1), value: 3 }] },
      ],
    },
  ]);
  assert.deepEqual(csv.split('\n'), [
    'Section (time series)',
    `t,'=cmd,'-layer,"a +b,c"`,
    '0,1,-2,',
    '1,,,3',
  ]);
});

check('numbers in the compact shape are untouched, and a non-number is not trusted', () => {
  const csv = metricGroupToCsv('Section', [
    { key: 'a', data: [{ timestamp: at(0), value: -0.5 }, { timestamp: at(2), value: NaN }] },
    // What the types forbid and a sample could still deliver.
    { key: 'b', data: [{ timestamp: at(0), value: '=1+1' as unknown as number }] },
  ]);
  assert.deepEqual(csv.split('\n').slice(2), ["0,-0.5,'=1+1", '2,,']);
});

check('hostile titles and keys hold under comma, semicolon and tab readings', () => {
  for (const text of HOSTILE) {
    const csv = metricGroupToCsv(`Unmatched RTP ${text}`, [
      { key: text, data: [{ timestamp: at(0), value: -1 }, { timestamp: at(1), value: 2 }] },
      { key: 'x', data: [], series: [{ key: `s${text}`, data: [{ timestamp: at(1), value: -0.5 }] }] },
    ]);
    assertHoldsUnderEveryReading(csv, [1, 3, 3, 3]);
    // The same text as the whole of the title cell, start to end.
    assertHoldsUnderEveryReading(metricGroupToCsv(text, COLUMNS, text), [1, 3, 3, 3]);
  }
});

console.log('\na realistic subsection');

check('an inbound RTP series carries every field it ever reported', () => {
  const csv = toCsv([
    { timestamp: T0, ssrc: 966900604, kind: 'video', packetsReceived: 0, packetsLost: 0 },
    { timestamp: T0 + 1000, ssrc: 966900604, kind: 'video', packetsReceived: 120, packetsLost: 1, framesDecoded: 24 },
    { timestamp: T0 + 2000, ssrc: 966900604, kind: 'video', packetsReceived: 245, packetsLost: 1, framesDecoded: 49, qualityLimitationReason: 'cpu' },
  ]);
  const rows = lines(csv);
  assert.equal(rows.length, 4);
  assert.equal(
    rows[0],
    'timestamp,timestampIso,ssrc,kind,packetsReceived,packetsLost,framesDecoded,qualityLimitationReason',
  );
  // Every row the same width, which is what a paste into a spreadsheet needs.
  const widths = new Set(rows.map((r) => r.split(',').length));
  assert.equal(widths.size, 1, `ragged rows: ${[...widths].join(', ')}`);
});

check('the first line is the header, with no title above it', () => {
  // The compact clipboard CSV in `metricSeriesExport` opens with a title line;
  // this one must not, or every column name lands one row down on paste.
  const rows = lines(toCsv([{ timestamp: T0, jitter: 1 }]));
  assert.ok(rows[0].startsWith('timestamp,'), rows[0]);
});

console.log(`\n${passed} checks passed`);
