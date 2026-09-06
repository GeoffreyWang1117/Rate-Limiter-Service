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

export function matchPattern(value: string, pattern?: string): boolean {
  // An absent or bare `*` pattern matches the whole dimension.
  if (!pattern || pattern === '*') return true;
  if (value === pattern) return true;

  const regex = compile(pattern);
  return regex ? regex.test(value) : false;
}

function compile(pattern: string): RegExp | null {
  const cached = cache.get(pattern);
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
  cache.set(pattern, regex);
  return regex;
}
