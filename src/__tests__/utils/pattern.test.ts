import { matchPattern } from '../../utils/pattern';

/**
 * Patterns are written by operators, stored, and then evaluated against every
 * request that reaches the rule. Getting the escaping wrong is not cosmetic: a
 * pattern that accidentally behaves as a regex matches traffic it was never
 * meant to govern, and silently applies the wrong limit to it.
 */
describe('matchPattern', () => {
  it('treats an absent or bare-star pattern as matching the whole dimension', () => {
    expect(matchPattern('anything', undefined)).toBe(true);
    expect(matchPattern('anything', '*')).toBe(true);
  });

  it('matches exactly when there is no wildcard', () => {
    expect(matchPattern('user:12345', 'user:12345')).toBe(true);
    expect(matchPattern('user:12346', 'user:12345')).toBe(false);
  });

  it('anchors globs, so a prefix pattern does not match mid-string', () => {
    expect(matchPattern('user:42', 'user:*')).toBe(true);
    expect(matchPattern('other:user:42', 'user:*')).toBe(false);
    expect(matchPattern('/api/v1/admin/keys', '/api/*')).toBe(true);
    expect(matchPattern('/internal/api/v1', '/api/*')).toBe(false);
  });

  it('treats a dot as a literal dot', () => {
    expect(matchPattern('10.0.0.7', '10.0.0.*')).toBe(true);
    // Would match if the dots compiled as "any character".
    expect(matchPattern('10x0y0z7', '10.0.0.*')).toBe(false);
  });

  /**
   * The original matcher escaped dots and nothing else, so any other regex
   * metacharacter an operator typed was interpreted rather than matched.
   */
  it('escapes the other regex metacharacters too', () => {
    expect(matchPattern('cost+tier', 'cost+*')).toBe(true);
    expect(matchPattern('costtier', 'cost+*')).toBe(false);

    expect(matchPattern('team(a)', 'team(a)*')).toBe(true);
    expect(matchPattern('teama', 'team(a)*')).toBe(false);

    expect(matchPattern('a|b', 'a|*')).toBe(true);
    expect(matchPattern('b', 'a|*')).toBe(false);

    expect(matchPattern('v1.0$', 'v1.0$*')).toBe(true);
  });

  it('supports ? as a single-character wildcard', () => {
    expect(matchPattern('gpt-4', 'gpt-?')).toBe(true);
    expect(matchPattern('gpt-4o', 'gpt-?')).toBe(false);
  });

  it('supports an explicit regex form delimited by slashes', () => {
    expect(matchPattern('user:12345', '/^user:\\d+$/')).toBe(true);
    expect(matchPattern('user:abc', '/^user:\\d+$/')).toBe(false);
    expect(matchPattern('admin-ops', '/^admin-/')).toBe(true);
  });

  it('matches nothing when a stored regex does not compile', () => {
    // Falling through to a lower-priority rule beats throwing on every request
    // that happens to reach a pattern an operator typo'd.
    expect(matchPattern('anything', '/[unclosed/')).toBe(false);
  });

  it('returns the same answer when a pattern is evaluated repeatedly', () => {
    // Compiled patterns are cached; the cache must not change the verdict.
    for (let i = 0; i < 3; i++) {
      expect(matchPattern('svc-7', 'svc-*')).toBe(true);
      expect(matchPattern('other', 'svc-*')).toBe(false);
    }
  });

  it('does not confuse a two-character pattern with the regex form', () => {
    // '/' and '//' start and end with a slash but are not a delimited regex.
    expect(matchPattern('/', '/')).toBe(true);
    expect(matchPattern('x', '//')).toBe(false);
  });
});
