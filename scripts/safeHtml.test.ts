/**
 * Tooltip markup: text from a sample stays text.
 *
 *   node --experimental-strip-types scripts/safeHtml.test.ts
 *
 * A chart tooltip is written into the page as HTML, and most of what it shows
 * was sent by a meeting participant. Three things have to hold for that to be
 * safe, and each fails without anything looking wrong in a browser:
 *
 *   1. the template encodes every value, wherever in the markup it lands;
 *   2. the tooltip builders, fed a sample written to break out, produce only
 *      the tags they were written with;
 *   3. no place in `src/` or `app/` writes HTML that did not come from the
 *      template — the check that fails the day someone adds one.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  SafeHtml,
  cssValue,
  escapeHtml,
  html,
  joinHtml,
  tableEntry,
  textLines,
  toHtmlString,
  toText,
} from '../src/utils/safeHtml.ts';
import { producerOverviewHoverHtml } from '../src/utils/formatting.ts';
import {
  producerEventTip,
  producerSegmentTip,
  streamRecordingIdTip,
} from '../src/utils/producerTimeline.ts';
import { miniChartTooltip } from '../src/utils/miniChartHelpers.ts';
import { episodeTooltipHtml, type ClientIssueEpisode } from '../src/utils/clientIssueEpisodes.ts';
import { CLIENT_ISSUE_TYPES, getIssueTypeMeta } from '../src/schema/ClientIssueTypes.ts';
import { buildChartData, finiteNumber } from '../src/utils/chartHelpers.ts';
import type { OutboundTimeSeriesValue } from '../src/utils/statsTypes.ts';
import {
  extractStreamRecordingIdEvents,
  payloadString,
} from '../src/schema/RecordingClientEventTypes.ts';

const T0 = 1_700_000_000_000;

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

/** Text written to become an element, an attribute and an entity all at once. */
const HOSTILE = `<img src=x onerror="alert(1)">'&<script>alert(2)</script>`;
const HOSTILE_ENCODED =
  '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&amp;&lt;script&gt;alert(2)&lt;/script&gt;';

/** JSON that throws when converted the careless way: `String()` calls `toString`. */
const UNPRINTABLE = JSON.parse('{"toString": 1, "valueOf": 2}') as unknown;

/** Every element the markup opens. */
function tagsIn(markup: string): string[] {
  return [...new Set([...markup.matchAll(/<([a-zA-Z][\w-]*)/g)].map((m) => m[1].toLowerCase()))].sort();
}

/** Every attribute, with its value, that the markup sets. */
function attributesIn(markup: string): string[] {
  return [...markup.matchAll(/<[a-zA-Z][^>]*>/g)].flatMap((tag) =>
    [...tag[0].matchAll(/\s([\w-]+)="([^"]*)"/g)].map((m) => `${m[1]}=${m[2]}`),
  );
}

/**
 * The hostile text made it into the tooltip as text, and nothing else of it
 * did: only the builder's own tags, and no attribute it did not write.
 */
function assertInert(tip: SafeHtml, allowedTags: string[]) {
  const markup = toHtmlString(tip);
  assert.deepEqual(
    tagsIn(markup).filter((t) => !allowedTags.includes(t)),
    [],
    `unexpected element in: ${markup}`,
  );
  for (const attribute of attributesIn(markup)) {
    assert.match(attribute, /^(?:class|style)=/, `unexpected attribute ${attribute} in: ${markup}`);
    assert.ok(!attribute.includes('alert'), `sample text inside an attribute: ${attribute}`);
  }
}

console.log('the escaper');

check('the five characters that end text or an attribute value are encoded', () => {
  assert.equal(escapeHtml('<'), '&lt;');
  assert.equal(escapeHtml('>'), '&gt;');
  assert.equal(escapeHtml('&'), '&amp;');
  assert.equal(escapeHtml('"'), '&quot;');
  // The single quote too: nothing here writes a single-quoted attribute, but
  // an escaper that skips it is one refactor away from mattering.
  assert.equal(escapeHtml("'"), '&#39;');
  assert.equal(escapeHtml(HOSTILE), HOSTILE_ENCODED);
});

check('an ampersand is encoded once, not twice', () => {
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
});

check('text with nothing to encode comes back unchanged', () => {
  assert.equal(escapeHtml('video · 12:00:01 – 12:00:09 (8.0s)'), 'video · 12:00:01 – 12:00:09 (8.0s)');
});

check('a value that is not a string is turned into one first', () => {
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(true), 'true');
  assert.equal(escapeHtml(null), 'null');
  assert.equal(escapeHtml(undefined), 'undefined');
  assert.equal(escapeHtml(['<b>', 1]), '&lt;b&gt;,1');
  assert.equal(escapeHtml({ a: 1 }), '[object Object]');
});

check('JSON whose toString is not a function does not throw', () => {
  // `String(value)` throws a TypeError here, which inside a render would take
  // the whole section down.
  assert.throws(() => String(UNPRINTABLE), TypeError);
  assert.equal(toText(UNPRINTABLE), '[object Object]');
  assert.equal(escapeHtml(UNPRINTABLE), '[object Object]');
});

console.log('\nthe template');

check('the literal part is markup, every value is text', () => {
  const tip = html`<strong>${HOSTILE}</strong><br/>${HOSTILE}`;
  assert.equal(toHtmlString(tip), `<strong>${HOSTILE_ENCODED}</strong><br/>${HOSTILE_ENCODED}`);
  assertInert(tip, ['strong', 'br']);
});

check('a template with no values is its literal part', () => {
  assert.equal(toHtmlString(html`<br/>still hidden`), '<br/>still hidden');
});

check('numbers, booleans and objects are shown as text', () => {
  assert.equal(toHtmlString(html`${1.5} ${false} ${{ a: 1 }}`), '1.5 false [object Object]');
  assert.equal(toHtmlString(html`<b>${UNPRINTABLE}</b>`), '<b>[object Object]</b>');
});

check('null and undefined show nothing', () => {
  // What makes `${cond ? html`...` : null}` usable for an optional part.
  assert.equal(toHtmlString(html`a${null}b${undefined}c`), 'abc');
});

check('a nested template is inserted as it is, not encoded again', () => {
  const inner = html`<em>${'a < b'}</em>`;
  assert.equal(toHtmlString(html`<p>${inner}</p>`), '<p><em>a &lt; b</em></p>');
});

check('an array is each of its items, by the same rules', () => {
  const rows = ['one', '<two>'].map((r) => html`<li>${r}</li>`);
  assert.equal(toHtmlString(html`<ul>${rows}</ul>`), '<ul><li>one</li><li>&lt;two&gt;</li></ul>');
  // A plain string in the array is data like any other.
  assert.equal(toHtmlString(html`${[html`<i>x</i>`, '<b>', null, 3]}`), '<i>x</i>&lt;b&gt;3');
});

check('text that looks like the output of the template is still text', () => {
  // Only the object the template returned is markup. Its string form is not.
  const forged = toHtmlString(html`<b>x</b>`);
  assert.equal(toHtmlString(html`${forged}`), '&lt;b&gt;x&lt;/b&gt;');
  assert.equal(toHtmlString(html`${{ html: '<b>' }}`), '[object Object]');
});

check('joinHtml puts a line break between parts, or the separator given', () => {
  const parts = [html`<b>a</b>`, html`${'<'}`];
  assert.equal(toHtmlString(joinHtml(parts)), '<b>a</b><br/>&lt;');
  assert.equal(toHtmlString(joinHtml(parts, html` · `)), '<b>a</b> · &lt;');
  assert.equal(toHtmlString(joinHtml([])), '');
});

check('textLines shows each value as one line of text', () => {
  assert.equal(toHtmlString(textLines(['a', '<b>', 3])), 'a<br/>&lt;b&gt;<br/>3');
});

console.log('\nvalues inside an attribute');

check('a colour from a table goes into a style as it is', () => {
  for (const color of ['#ef4444', '#fff', 'var(--text-muted)', 'rgba(148,163,184,0.12)', 'transparent']) {
    assert.equal(toHtmlString(html`<b style="color:${color}">x</b>`), `<b style="color:${color}">x</b>`);
  }
  assert.equal(toHtmlString(html`<i style="width:${8}px"></i>`), '<i style="width:8px"></i>');
});

check('anything else is left out of a style, not just encoded', () => {
  // Encoding stops the value from ending the attribute. It does not stop it
  // from being CSS: a second declaration, or a url() fetched on hover.
  for (const value of [
    'red;background:url(https://example.org/x)',
    'url(https://example.org/x)',
    'expression(alert(1))',
    'red" onmouseover="alert(1)',
    '',
    HOSTILE,
    null,
    undefined,
    { color: 'red' },
    UNPRINTABLE,
    () => 'red',
  ]) {
    assert.equal(toHtmlString(html`<b style="color:${value}">x</b>`), '<b style="color:">x</b>');
  }
});

check('the style check knows which value sits in which attribute', () => {
  const tip = html`<b style="color:${'#fff'};background:${'x;y'}" class="${'a b'}">${'x;y'}</b>`;
  assert.equal(toHtmlString(tip), '<b style="color:#fff;background:" class="a b">x;y</b>');
});

check('a class value is encoded and cannot leave its attribute', () => {
  const tip = html`<span class="${'note" onmouseover="alert(1)'}">x</span>`;
  assert.equal(toHtmlString(tip), '<span class="note&quot; onmouseover=&quot;alert(1)">x</span>');
  assert.deepEqual(attributesIn(toHtmlString(tip)).map((a) => a.split('=')[0]), ['class']);
  assert.equal(toHtmlString(html`<span class="${7}">x</span>`), '<span class="">x</span>');
});

check('no other attribute takes a value', () => {
  // href, src and on* need more than encoding, and no tooltip needs them.
  assert.throws(() => html`<a href="${'https://example.org'}">x</a>`, /class.*style/);
  assert.throws(() => html`<b title="${'x'}">x</b>`, /class.*style/);
  assert.throws(() => html`<b onclick="${'x'}">x</b>`, /class.*style/);
});

check('a value outside quotes inside a tag is refused', () => {
  assert.throws(() => html`<b ${'x'}>y</b>`, /inside a tag/);
  assert.throws(() => html`<b style=${'red'}>y</b>`, /inside a tag/);
  assert.throws(() => html`<${'b'}>y</b>`, /inside a tag/);
  // Single-quoted attributes are not tracked, so they are not accepted either.
  assert.throws(() => html`<b style='color:${'red'}'>y</b>`, /inside a tag/);
});

check('markup may not arrive as a value in an attribute', () => {
  assert.equal(toHtmlString(html`<b style="color:${html`red`}">x</b>`), '<b style="color:">x</b>');
  assert.equal(toHtmlString(html`<b class="${html`a`}">x</b>`), '<b class="">x</b>');
});

check('script and style elements are not written with the template', () => {
  assert.throws(() => html`<script>${'x'}</script>`, /script/);
  assert.throws(() => html`<style>${'x'}</style>`, /script/);
});

check('cssValue falls back when the value is not a plain CSS value', () => {
  assert.equal(cssValue('#10b981'), '#10b981');
  assert.equal(cssValue('var(--accent)', 'inherit'), 'var(--accent)');
  assert.equal(cssValue('red;x', 'inherit'), 'inherit');
  assert.equal(cssValue(12), '12');
  assert.equal(cssValue(NaN, '0'), '0');
});

console.log('\nwhat counts as markup');

check('the result is an object, not a string', () => {
  const tip = html`<b>x</b>`;
  assert.ok(tip instanceof SafeHtml);
  assert.notEqual(typeof tip, 'string');
  // Nothing readable on it either: the markup is only reachable through
  // toHtmlString, which is the call the source check looks for at a sink.
  assert.deepEqual(Object.keys(tip), []);
  assert.equal(JSON.stringify(tip), '{}');
});

check('a SafeHtml cannot be constructed from a string', () => {
  const Forge = SafeHtml as unknown as new (...args: unknown[]) => SafeHtml;
  assert.throws(() => new Forge('<b>'), TypeError);
  assert.throws(() => new Forge(Symbol('SafeHtml'), '<b>'), TypeError);
});

check('html is a template tag and refuses to be called with a string or an array', () => {
  const call = html as unknown as (...args: unknown[]) => SafeHtml;
  assert.throws(() => call('<b>'), TypeError);
  assert.throws(() => call(['<b>']), TypeError);
});

check('toHtmlString takes only what the template made', () => {
  const unwrap = toHtmlString as (value: unknown) => string;
  assert.throws(() => unwrap('<b>x</b>'), TypeError);
  assert.throws(() => unwrap({ toString: () => '<b>' }), TypeError);
  assert.throws(() => unwrap(Object.create(SafeHtml.prototype)), TypeError);
  assert.throws(() => unwrap(null), TypeError);
  assert.throws(() => joinHtml(['<b>' as unknown as SafeHtml]), TypeError);
});

console.log('\ntooltip builders, fed a hostile sample');

check('producer row hover: id and label are text', () => {
  const tip = producerOverviewHoverHtml({ id: HOSTILE, kind: 'video', label: HOSTILE });
  assertInert(tip, ['span']);
  const markup = toHtmlString(tip);
  assert.equal(markup.split(HOSTILE_ENCODED).length - 1, 2, markup);
});

check('producer row hover: a label that is not a string is ignored, not called', () => {
  // `label.trim()` on a number throws; the label is the client's.
  for (const label of [7, { trim: 1 }, ['x'], true]) {
    const tip = producerOverviewHoverHtml({ id: 'p1', kind: 'audio', label: label as unknown as string });
    assert.equal(toHtmlString(tip), '<span style="font-family:ui-monospace,monospace">p1</span>');
  }
});

check('overview point marker: label and extra are text, the colour is checked', () => {
  const tip = producerEventTip(HOSTILE, 'red;background:url(x)', T0, 'utc', HOSTILE);
  assertInert(tip, ['strong', 'br', 'span']);
  assert.ok(toHtmlString(tip).startsWith(`<strong style="color:">${HOSTILE_ENCODED}</strong><br/>`));
  // The ordinary case is untouched.
  assert.ok(toHtmlString(producerEventTip('added', '#10b981', T0, 'utc')).startsWith(
    '<strong style="color:#10b981">added</strong><br/>',
  ));
});

check('overview lifecycle span: the state is text', () => {
  const tip = producerSegmentTip(
    { start: T0, end: T0 + 5000, state: HOSTILE, color: '#64748b', opacity: 1 },
    'utc',
  );
  assertInert(tip, ['strong', 'br']);
  assert.ok(toHtmlString(tip).includes(HOSTILE_ENCODED));
});

check('stream recording id change: source and new id are text', () => {
  const tip = streamRecordingIdTip({ timestamp: T0, newId: '<i>&"\'x', source: HOSTILE }, 'utc');
  assertInert(tip, ['strong', 'br', 'code', 'span']);
  const markup = toHtmlString(tip);
  assert.ok(markup.includes('<code class="id-badge">&lt;i&gt;&amp;&quot;&#39;x</code>'), markup);
  assert.ok(markup.includes(`<span style="color:var(--text-muted)">${HOSTILE_ENCODED}</span>`), markup);
});

check('stream recording id change: fields that are not strings are dropped at extraction', () => {
  const events = extractStreamRecordingIdEvents([
    {
      timestamp: new Date(T0),
      type: 'STREAM_RECORDING_ID_CHANGED',
      payload: { newId: { toString: 1 }, source: ['<b>'] },
    },
    { timestamp: new Date(T0 + 1), type: 'STREAM_RECORDING_ID_CHANGED', payload: { newId: 'abc', source: HOSTILE } },
  ]);
  assert.deepEqual(events, [
    { timestamp: T0, newId: undefined, source: undefined },
    { timestamp: T0 + 1, newId: 'abc', source: HOSTILE },
  ]);
  for (const ev of events) assertInert(streamRecordingIdTip(ev, 'utc'), ['strong', 'br', 'code', 'span']);
});

check('chart crosshair: series label, formatted value and notes are text', () => {
  const tip = miniChartTooltip({
    readings: [{ label: `Playout Delay (${HOSTILE})`, color: 'var(--accent)', value: `${HOSTILE}p` }],
    notes: [HOSTILE, HOSTILE, '  ', 5, null],
    time: '12:00:00.000',
    noteClass: 'note',
  });
  assertInert(tip, ['span', 'strong', 'br']);
  assert.equal(
    toHtmlString(tip),
    `<span style="color:var(--accent)">Playout Delay (${HOSTILE_ENCODED}): <strong>${HOSTILE_ENCODED}p</strong></span>` +
      '<br/><span style="color:var(--text-muted)">12:00:00.000</span>' +
      `<br/><span class="note">${HOSTILE_ENCODED}</span>`,
  );
});

check('chart crosshair: a series colour that is not a colour is left out', () => {
  const tip = miniChartTooltip({
    readings: [{ label: 'a', color: 'red" onmouseover="alert(1)', value: UNPRINTABLE }],
    notes: [],
    time: 't',
    noteClass: 'note',
  });
  assertInert(tip, ['span', 'strong', 'br']);
  assert.ok(toHtmlString(tip).startsWith('<span style="color:">a: <strong>[object Object]</strong></span>'));
});

check('chart crosshair: a region tooltip is markup only if the template made it', () => {
  const made = miniChartTooltip({
    readings: [{ label: 'a', color: '#fff', value: '1' }],
    notes: [],
    time: 't',
    regionTip: html`<strong>${HOSTILE}</strong>`,
    noteClass: 'note',
  });
  assertInert(made, ['strong', 'br', 'span']);
  assert.ok(toHtmlString(made).startsWith(`<strong>${HOSTILE_ENCODED}</strong><br/><span`));

  // A caller that got a plain string past the compiler: shown, not parsed.
  const forced = miniChartTooltip({
    readings: [],
    notes: [],
    time: 't',
    regionTip: HOSTILE as unknown as SafeHtml,
    noteClass: 'note',
  });
  assert.equal(toHtmlString(forced), HOSTILE_ENCODED);
});

check('issue episode: comment, payload values and an unknown type name are text', () => {
  const episode: ClientIssueEpisode = {
    type: HOSTILE,
    raisedAt: T0,
    resolvedAt: T0 + 4000,
    durationMs: 4000,
    stillOpen: false,
    resolvedByClient: true,
    resolveComment: HOSTILE,
    payload: { trackId: HOSTILE },
    resolvePayload: null,
    trackId: HOSTILE,
    transportId: HOSTILE,
    summary: '',
  };
  const tip = episodeTooltipHtml(getIssueTypeMeta(HOSTILE), episode, 'utc');
  assertInert(tip, ['strong', 'br', 'span']);
  assert.ok(toHtmlString(tip).includes(`resolved</span> ${HOSTILE_ENCODED}`));
});

check('issue episode: highlighted payload fields of any JSON type are shown, not run', () => {
  // Every known issue type, every field its tooltip highlights, every kind of
  // value JSON can put there. The formatters differ per field (ms, bytes,
  // fraction, ...), and each has its own way to mishandle a non-number.
  const values = [HOSTILE, UNPRINTABLE, [HOSTILE], { a: HOSTILE }, 12.5, true, '17'];
  let fields = 0;
  for (const [type, meta] of Object.entries(CLIENT_ISSUE_TYPES)) {
    for (const value of values) {
      const payload: Record<string, unknown> = {};
      for (const field of meta.highlightFields) payload[field.key] = value;
      fields += meta.highlightFields.length;
      const episode: ClientIssueEpisode = {
        type,
        raisedAt: T0,
        stillOpen: true,
        resolvedByClient: false,
        payload,
        resolvePayload: null,
        summary: '',
      };
      assertInert(episodeTooltipHtml(meta, episode, 'utc'), ['strong', 'br', 'span']);
    }
  }
  assert.ok(fields > 100, `only ${fields} highlighted fields exercised`);
});

console.log('\nwhat a sample may contribute');

check('only a finite number is a number', () => {
  assert.equal(finiteNumber(0), 0);
  assert.equal(finiteNumber(-1.5), -1.5);
  for (const value of ['5', HOSTILE, null, undefined, true, [1], { valueOf: 1 }, NaN, Infinity, -Infinity]) {
    assert.equal(finiteNumber(value), undefined, `accepted ${String(value)}`);
  }
});

check('a chart gets a point only for a finite number', () => {
  const rows = [
    { timestamp: T0, packetsSent: 10 },
    { timestamp: T0 + 1000, packetsSent: HOSTILE },
    { timestamp: T0 + 2000, packetsSent: '30' },
    { timestamp: T0 + 3000, packetsSent: { a: 1 } },
    { timestamp: T0 + 4000, packetsSent: [40] },
    { timestamp: T0 + 5000, packetsSent: null },
    { timestamp: T0 + 6000, packetsSent: NaN },
    { timestamp: T0 + 7000, packetsSent: true },
    { timestamp: T0 + 8000, packetsSent: 50 },
  ] as unknown as OutboundTimeSeriesValue[];
  const [chart] = buildChartData(rows, [{ title: 'Packets Sent', extract: (v) => v.packetsSent }]);
  assert.deepEqual(chart.data.map((d) => d.value), [10, 50]);
  assert.ok(chart.data.every((d) => typeof d.value === 'number'));
});

check('a chart whose samples hold only strings does not exist', () => {
  const rows = [
    { timestamp: T0, frameHeight: `${HOSTILE}` },
    { timestamp: T0 + 1000, frameHeight: '720' },
    { timestamp: T0 + 2000, frameHeight: '720' },
  ] as unknown as OutboundTimeSeriesValue[];
  // The definition as the sections wrote it before: no check of its own.
  assert.deepEqual(buildChartData(rows, [{ title: 'Resolution', extract: (v) => v.frameHeight || undefined }]), []);
});

check('a summed definition adds numbers only', () => {
  // `(a || 0) + (b || 0)` on a string is concatenation: the "sum" becomes
  // text, and the text becomes the tooltip.
  const rows = [
    { timestamp: T0, nackCount: 1, pliCount: HOSTILE, firCount: '2' },
    { timestamp: T0 + 1000, nackCount: 2, pliCount: 3, firCount: { a: 1 } },
    { timestamp: T0 + 2000 },
  ] as unknown as OutboundTimeSeriesValue[];
  const [chart] = buildChartData(rows, [
    {
      title: 'Quality Issues (NACK+PLI+FIR)',
      extract: (v) =>
        (finiteNumber(v.nackCount) ?? 0) + (finiteNumber(v.pliCount) ?? 0) + (finiteNumber(v.firCount) ?? 0),
    },
  ]);
  assert.deepEqual(chart.data.map((d) => d.value), [1, 5, 0]);
});

check('a payload field is a state name or an id only if it is a string', () => {
  const payload = JSON.parse(
    '{"takeId":"take-1","archiveId":7,"prevState":{"toString":1},"actualState":["error"],"newState":null,"source":true,"state":"<b>"}',
  ) as Record<string, unknown>;
  assert.equal(payloadString(payload, 'takeId'), 'take-1');
  // Markup in a string is still a string; it is the sink that keeps it text.
  assert.equal(payloadString(payload, 'state'), '<b>');
  for (const field of ['archiveId', 'prevState', 'actualState', 'newState', 'source', 'missing']) {
    assert.equal(payloadString(payload, field), undefined, field);
  }
  assert.equal(payloadString(null, 'takeId'), undefined);
  assert.equal(payloadString(undefined, 'takeId'), undefined);
});

check('a payload string is cut to a length a label can carry', () => {
  assert.equal(payloadString({ takeId: 'x'.repeat(10_000) }, 'takeId')?.length, 256);
});

check('a table is asked only for its own entries', () => {
  const colors = { idle: '#94a3b8', error: '#dc2626' };
  assert.equal(tableEntry(colors, 'error'), '#dc2626');
  // `colors['constructor']` is a function, and `?? fallback` does not catch it.
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'nope', '', 7, null, undefined, {}]) {
    assert.equal(tableEntry(colors, key), undefined, `answered for ${String(key)}`);
  }
});

console.log('\nno sink takes anything but the template\'s output');

/** The call that must directly follow a sink, and what has to close it. */
const SINKS: Array<{ name: string; find: RegExp; open: string; close: string; alsoAllowed?: RegExp }> = [
  { name: 'd3 .html()', find: /\.html\(/g, open: '.html(', close: ')' },
  { name: 'innerHTML', find: /\binnerHTML\b/g, open: 'innerHTML = ', close: ';', alsoAllowed: /^innerHTML = '';/ },
  { name: 'dangerouslySetInnerHTML', find: /dangerouslySetInnerHTML/g, open: 'dangerouslySetInnerHTML={{ __html: ', close: ' }}' },
  { name: '__html', find: /__html/g, open: '__html: ', close: ' }' },
];

/** Other ways to parse a string as HTML, or to pass a string off as SafeHtml. None is used. */
const FORBIDDEN: Array<{ name: string; find: RegExp; inSafeModule?: boolean }> = [
  { name: 'outerHTML', find: /\bouterHTML\b/, inSafeModule: true },
  { name: 'insertAdjacentHTML', find: /insertAdjacentHTML/, inSafeModule: true },
  { name: 'document.write', find: /document\.write/, inSafeModule: true },
  { name: 'srcdoc', find: /\bsrcdoc\b/i, inSafeModule: true },
  { name: 'createContextualFragment', find: /createContextualFragment/, inSafeModule: true },
  { name: 'DOMParser', find: /\bDOMParser\b/, inSafeModule: true },
  { name: 'setHTMLUnsafe', find: /setHTMLUnsafe/, inSafeModule: true },
  { name: 'a cast to SafeHtml', find: /\bas SafeHtml\b/ },
  { name: 'new SafeHtml()', find: /new SafeHtml\(/ },
  { name: 'html called as a function', find: /(?<![.\w])html\(/ },
];

const SAFE_CALL = 'toHtmlString(';

/** Index just past the `)` that closes the `(` ending at `from`, or -1. */
function closingParen(text: string, from: number): number {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')' && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * What is wrong with one line of source, if anything.
 *
 * The convention is deliberately dumb so that it can be checked by reading a
 * line: the sink's whole argument is one `toHtmlString(...)` call, opened and
 * closed on that line. `toHtmlString(a) + b` fails, as does an argument held
 * in a variable — the reader of the sink should not have to go looking.
 */
function problemsIn(line: string, isSafeModule = false): string[] {
  const problems: string[] = [];
  for (const sink of SINKS) {
    for (const match of line.matchAll(sink.find)) {
      const rest = line.slice(match.index);
      if (sink.alsoAllowed?.test(rest)) continue;
      const opener = sink.open + SAFE_CALL;
      const end = rest.startsWith(opener) ? closingParen(rest, opener.length) : -1;
      if (end === -1 || !rest.slice(end).startsWith(sink.close)) {
        problems.push(`${sink.name} must be given exactly ${SAFE_CALL}...) on one line`);
      }
    }
  }
  for (const rule of FORBIDDEN) {
    if (isSafeModule && !rule.inSafeModule) continue;
    if (rule.find.test(line)) problems.push(`${rule.name} is not allowed`);
  }
  return problems;
}

check('the check accepts the three sink forms and the container reset', () => {
  for (const line of [
    "          .html(toHtmlString(tip))",
    "    tooltip.html(toHtmlString(tip)).style('opacity', '1')",
    "              tooltipDiv.style('opacity', '1').html(toHtmlString(iceSegmentTooltip(seg, tz)))",
    '            tooltip.innerHTML = toHtmlString(tip);',
    "    container.innerHTML = '';",
    '          dangerouslySetInnerHTML={{ __html: toHtmlString(tooltip.html) }}',
    "import { html, toHtmlString, type SafeHtml } from '../../utils/safeHtml.ts';",
    '  const tip = html`<strong>${label}</strong>`;',
    '  show: (ev: MouseEvent, tip: SafeHtml) => void;',
  ]) {
    assert.deepEqual(problemsIn(line), [], line);
  }
});

check('the check rejects every other way of reaching a sink', () => {
  for (const line of [
    '        .html(html)',
    '        .html(`<strong>${label}</strong>`)',
    '        .html(',
    '        .html(tip.toString())',
    '        .html(String(toHtmlString(tip)))',
    '        .html(toHtmlString(tip) + label)',
    '        .html(toHtmlString(tip), label)',
    '        .html(toHtmlString(',
    '        const old = tooltipDiv.html();',
    '    tooltip.innerHTML = html;',
    '    tooltip.innerHTML = `<b>${x}</b>`;',
    '    tooltip.innerHTML += toHtmlString(tip);',
    '    tooltip.innerHTML = toHtmlString(tip) + x;',
    "    tooltip.innerHTML = '' + x;",
    "    tooltip['innerHTML'] = x;",
    "    d3.select(el).property('innerHTML', x);",
    '          dangerouslySetInnerHTML={{ __html: tooltip.html }}',
    '          dangerouslySetInnerHTML={{ __html: toHtmlString(tooltip.html) + x }}',
    '          dangerouslySetInnerHTML={markup}',
    '  const markup = { __html: text };',
    '    el.outerHTML = x;',
    "    el.insertAdjacentHTML('beforeend', x);",
    '    document.write(x);',
    '    frame.srcdoc = x;',
    '    const doc = new DOMParser().parseFromString(x, "text/html");',
    '    const tip = text as SafeHtml;',
    '    const tip = text as unknown as SafeHtml;',
    '    const tip = new SafeHtml(key, text);',
    "    const tip = html(['<b>'] as never);",
  ]) {
    assert.notDeepEqual(problemsIn(line), [], `accepted: ${line}`);
  }
});

/** Source files under a directory. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(?:tsx?|jsx?|mjs|cjs)$/.test(path)) out.push(path);
  }
  return out;
}

/** The lines of a file that are code: whole-line and block comments are prose. */
function codeLines(path: string): Array<{ number: number; text: string }> {
  const out: Array<{ number: number; text: string }> = [];
  let inBlock = false;
  readFileSync(path, 'utf8').split('\n').forEach((text, i) => {
    const trimmed = text.trim();
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false;
      return;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true;
      return;
    }
    if (trimmed.startsWith('//')) return;
    out.push({ number: i + 1, text });
  });
  return out;
}

const SAFE_MODULE = join('src', 'utils', 'safeHtml.ts');
const files = [...sourceFiles('src'), ...sourceFiles('app')];
let sinksSeen = 0;
const offences: string[] = [];
for (const file of files) {
  for (const { number, text } of codeLines(file)) {
    if (SINKS.some((sink) => text.search(sink.find) !== -1)) sinksSeen += 1;
    for (const problem of problemsIn(text, file === SAFE_MODULE)) {
      offences.push(`${file}:${number}: ${problem}\n      ${text.trim()}`);
    }
  }
}

check('the walk reads the source tree and finds the sinks that exist', () => {
  // A check that scanned nothing would pass for ever.
  assert.ok(files.length > 100, `only ${files.length} files`);
  assert.ok(files.includes(SAFE_MODULE));
  assert.ok(files.some((f) => f.startsWith('app')));
  assert.ok(sinksSeen >= 20, `only ${sinksSeen} sink lines found`);
});

check(`every sink in src/ and app/ is given toHtmlString(...) (${sinksSeen} lines)`, () => {
  assert.deepEqual(offences, [], `\n${offences.join('\n')}\n`);
});

check('the safe module itself writes to no sink', () => {
  assert.ok(!codeLines(SAFE_MODULE).some(({ text }) => SINKS.some((sink) => text.search(sink.find) !== -1)));
});

console.log(`\n${passed} checks passed`);
