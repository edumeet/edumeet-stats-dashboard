/**
 * HTML for chart tooltips, built so that text from a sample stays text.
 *
 * Every field of a client sample, a router sample or a call summary is written
 * by a meeting participant and can hold any JSON value. A tooltip assembled as
 * a string and handed to `innerHTML` turns such a field into markup, and with
 * it into script running in the browser of whoever reads the report. So markup
 * is not assembled from strings here at all.
 *
 * The convention — `scripts/safeHtml.test.ts` walks `src/` and `app/` and
 * fails when it is broken:
 *
 *   1. Markup is written only as an html`...` template. Each `${value}` in it
 *      is HTML-encoded, quotes included, unless it is itself a `SafeHtml` (or
 *      an array of them), which is how a tooltip is composed from parts.
 *   2. A sink — d3 `.html(`, `innerHTML =`, `dangerouslySetInnerHTML` — is
 *      given `toHtmlString(x)`, written on the sink's own line, and nothing
 *      else. `toHtmlString` takes a `SafeHtml` only, checked by the compiler
 *      and again when it runs. `el.innerHTML = '';` to empty a container is
 *      the one exception.
 *   3. Anything that carries tooltip markup between functions or components is
 *      typed `SafeHtml`, never `string`, so a caller passing a plain string
 *      does not compile. There is no cast and no "trusted string" escape
 *      hatch: static markup belongs in the literal part of a template.
 *   4. Inside `style="..."` a value is used only if it is a plain CSS value
 *      (a colour, a number, `var(--x)`); encoding alone would still let a
 *      sample add declarations. Inside `class="..."` it is encoded. No other
 *      attribute, and no place inside a tag outside quotes, takes a value.
 *
 * No JSX, no path alias, no DOM: plain Node imports this file in the tests.
 */

const key = Symbol('SafeHtml');

/**
 * Markup that only the `html` template produced. The private field makes the
 * type nominal — no string and no object literal is assignable to it — and the
 * unexported key keeps `new SafeHtml(...)` from working anywhere else.
 */
export class SafeHtml {
  readonly #html: string;

  constructor(k: typeof key, markup: string) {
    if (k !== key) throw new TypeError('SafeHtml is made by the html`` template, not from a string');
    this.#html = markup;
  }

  [key](): string {
    return this.#html;
  }
}

/**
 * A string for any JSON value, without calling into the value. `String()` on
 * an object whose `toString` is not a function throws, and `{"toString": 1}`
 * is valid JSON.
 */
export function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return String(value);
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** HTML-encode a value for element content or a quoted attribute. */
export function escapeHtml(value: unknown): string {
  return toText(value).replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

const CSS_VALUE =
  /^(?:#[0-9a-f]{3,8}|[a-z][a-z-]*|var\(--[\w-]+\)|(?:rgb|hsl)a?\([\d\s.,%/]+\)|-?\d+(?:\.\d+)?(?:px|em|rem|%)?)$/i;

/**
 * A value fit to stand after `property:` in an inline style: a hex colour, a
 * keyword, `var(--name)`, `rgb()`/`hsl()` or a number with a unit. Anything
 * else yields the fallback; the empty default makes the browser drop that one
 * declaration.
 */
export function cssValue(value: unknown, fallback = ''): string {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  return typeof text === 'string' && CSS_VALUE.test(text) ? text : fallback;
}

/**
 * The entry a fixed table has for a key that came from a sample. `table[key]`
 * also answers for `constructor`, `toString` and the rest of the prototype,
 * and what it returns then is not a colour or a label.
 */
export function tableEntry<T>(table: Readonly<Record<string, T>>, tableKey: unknown): T | undefined {
  return typeof tableKey === 'string' && Object.prototype.hasOwnProperty.call(table, tableKey)
    ? table[tableKey]
    : undefined;
}

type Context = 'text' | 'style' | 'class' | 'attribute' | 'tag';

const contextCache = new WeakMap<TemplateStringsArray, Context[]>();

/**
 * Where in the markup each `${}` of a template sits. Only the literal parts
 * are read: an encoded value holds no `<`, `>` or quote and so cannot move the
 * position, and a nested SafeHtml is accepted in element content only.
 */
function contextsOf(strings: TemplateStringsArray): Context[] {
  const cached = contextCache.get(strings);
  if (cached) return cached;

  if (/<\s*(?:script|style)\b/i.test(strings.join(''))) {
    throw new TypeError('html``: <script> and <style> are not written with this template');
  }

  const contexts: Context[] = [];
  let inTag = false;
  let attribute: string | null = null;
  for (let i = 0; i < strings.length - 1; i++) {
    const part = strings[i];
    for (let j = 0; j < part.length; j++) {
      const c = part[j];
      if (attribute !== null) {
        if (c === '"') attribute = null;
      } else if (inTag) {
        if (c === '>') inTag = false;
        else if (c === '"') attribute = /([\w-]+)\s*=\s*$/.exec(part.slice(0, j))?.[1].toLowerCase() ?? '';
      } else if (c === '<') {
        inTag = true;
      }
    }
    if (attribute === 'style' || attribute === 'class') contexts.push(attribute);
    else if (attribute !== null) contexts.push('attribute');
    else contexts.push(inTag ? 'tag' : 'text');
  }
  contextCache.set(strings, contexts);
  return contexts;
}

function render(value: unknown, context: Context): string {
  switch (context) {
    case 'text':
      if (value instanceof SafeHtml) return value[key]();
      if (Array.isArray(value)) return value.map((item) => render(item, 'text')).join('');
      // As JSX does: nothing to show, rather than the word "undefined".
      if (value === null || value === undefined) return '';
      return escapeHtml(value);
    case 'style':
      return cssValue(value);
    case 'class':
      return typeof value === 'string' ? escapeHtml(value) : '';
    case 'attribute':
      throw new TypeError('html``: only class="..." and style="..." take a value');
    case 'tag':
      throw new TypeError('html``: a value inside a tag must be inside a double-quoted class or style');
  }
}

/**
 * The tagged template every piece of tooltip markup is written with:
 *
 *   html`<strong>${label}</strong><br/>${time}`
 *
 * The literal part is the markup; the values are data and are encoded.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  // A template object carries `raw`; an array passed by hand to stand in for
  // the literal part does not.
  if (!Array.isArray(strings) || !Array.isArray(strings.raw)) {
    throw new TypeError('html is a template tag: write html`...`, do not call it');
  }
  const contexts = contextsOf(strings);
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += render(values[i], contexts[i]) + strings[i + 1];
  }
  return new SafeHtml(key, out);
}

const BR = html`<br/>`;

/** Parts in order, with a separator between them: a line break unless told otherwise. */
export function joinHtml(parts: readonly SafeHtml[], separator: SafeHtml = BR): SafeHtml {
  const sep = toHtmlString(separator);
  return new SafeHtml(key, parts.map(toHtmlString).join(sep));
}

/** Plain values as lines of text, one per `<br/>`. */
export function textLines(lines: readonly unknown[]): SafeHtml {
  return joinHtml(lines.map((line) => html`${line}`));
}

/**
 * The markup as a string, for the sink and nowhere else. Refuses anything the
 * template did not make, so a cast that got a string past the compiler still
 * stops here.
 */
export function toHtmlString(safe: SafeHtml): string {
  if (!(safe instanceof SafeHtml)) {
    throw new TypeError('toHtmlString() takes the result of an html`` template');
  }
  return safe[key]();
}
