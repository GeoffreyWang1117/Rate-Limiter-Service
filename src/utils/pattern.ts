/**
 * Glob and regex matching for rule and policy dimensions.
 *
 * Patterns come from operators through the control-plane API, so the compiled
 * form is cached: recompiling a RegExp for every pattern on every request puts
 * avoidable work on the admission path, and an operator-supplied pattern that is
 * expensive to compile should be paid for once.
 */
const cache = new Map<string, RegExp | null>();
const MAX_CACHE = 1_000;

const REGEX_METACHARS = /[.*+?^${}()|[\]\\]/g;

/**
 * Longest value a stored regex is run against.
 *
 * This does NOT make backtracking safe. Blowup is exponential in subject length,
 * not superlinear, so a pattern like `(a+)+$` against even a few dozen
 * characters does not finish in any useful time. The cap only removes the easy
 * amplification; the guard below removes the easy pattern. A genuine fix needs a
 * linear-time engine such as RE2, which is recorded as the open item.
 *
 * Kept short because the values this applies to are request metadata -- a tier
 * name, a region -- which are short by nature.
 */
const MAX_SUBJECT = 256;

/**
 * Rejects the regex shapes behind practical catastrophic backtracking: a group
 * that is itself quantified and whose body can match the same input more than
 * one way. Two cases cover almost all of it -- a quantifier inside a quantified
 * group (`(a+)+`, `([ab]{2,})+`), and an alternation inside one (`(a|a)*`).
 *
 * This replaces a regular expression that tried to do the same job and silently
 * did not: it required two closing parens, so it never matched `(a+)+$` at all.
 * A test now pins each shape, because an unexercised guard is indistinguishable
 * from no guard -- `(a+)+$` against 200 characters ran for 167 seconds through
 * the version that was supposed to be stopping it.
 *
 * It is a denylist, so it is not complete: overlap between alternation branches
 * is undecidable in general, and a sufficiently creative pattern will get
 * through. It is defence in depth behind the control-plane key, and the real
 * fix is a linear-time engine (RE2), which is recorded as an open item.
 * Conservative by design: it will reject some safe patterns, such as a
 * quantified alternation, which can always be rewritten unquantified.
 */
function scanForQuantifier(body: string, alsoAlternation: boolean): boolean {
  let inClass = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\') { i++; continue; }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') { inClass = true; continue; }
    if (ch === '*' || ch === '+') return true;
    if (ch === '{' && /^\{\d+,/.test(body.slice(i))) return true;
    if (alsoAlternation && ch === '|') return true;
  }
  return false;
}

function hasNestedQuantifier(source: string): boolean {
  const open: number[] = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') { i++; continue; }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') { inClass = true; continue; }
    if (ch === '(') { open.push(i); continue; }
    if (ch !== ')') continue;

    const start = open.pop();
    if (start === undefined) continue;
    const next = source[i + 1];
    const quantified = next === '*' || next === '+' || (next === '{' && /^\{\d+,/.test(source.slice(i + 1)));
    if (quantified && scanForQuantifier(source.slice(start + 1, i), true)) return true;
  }
  return false;
}

export function matchRegex(value: string, source: string): boolean {
  const regex = compileRaw(source);
  if (!regex) return false;
  return regex.test(value.length > MAX_SUBJECT ? value.slice(0, MAX_SUBJECT) : value);
}

function compileRaw(source: string): RegExp | null {
  // Namespaced separately from compile()'s keys, which are the pattern string
  // verbatim -- otherwise a dimension pattern that literally reads `raw:^gold$`
  // would be served the compiled regex cached for the custom pattern
  // `tier~^gold$` and match the wrong traffic.
  const key = `raw\u0000${source}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let regex: RegExp | null = null;
  try {
    regex = hasNestedQuantifier(source) ? null : new RegExp(source);
  } catch {
    regex = null;
  }
  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(key, regex);
  return regex;
}

export function matchPattern(value: string, pattern?: string): boolean {
  // An absent or bare `*` pattern matches the whole dimension.
  if (!pattern || pattern === '*') return true;
  if (value === pattern) return true;

  const regex = compile(pattern);
  return regex ? regex.test(value) : false;
}

function compile(pattern: string): RegExp | null {
  const key = `glob\u0000${pattern}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let regex: RegExp | null = null;
  try {
    if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
      // Explicit regex form: /^admin-/
      regex = new RegExp(pattern.slice(1, -1));
    } else if (pattern.includes('*') || pattern.includes('?')) {
      // Glob form. Every non-wildcard character is escaped, so a pattern like
      // `10.0.0.*` cannot have its dots reinterpreted as "any character" -- the
      // original implementation escaped dots but nothing else, which let a
      // pattern containing `+` or `(` behave as a regex by accident.
      const source = Array.from(pattern)
        .map((ch) => {
          if (ch === '*') return '.*';
          if (ch === '?') return '.';
          return ch.replace(REGEX_METACHARS, '\\$&');
        })
        .join('');
      regex = new RegExp(`^${source}$`);
    }
  } catch {
    // An operator saved a pattern that does not compile. Matching nothing is the
    // safe reading: it falls through to a lower-priority rule or the default.
    regex = null;
  }

  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(key, regex);
  return regex;
}
