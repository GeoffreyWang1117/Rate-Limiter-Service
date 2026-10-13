import { matchRegex, matchPattern } from '../../utils/pattern';

describe('stored-regex guard', () => {
  it.each([
    ['classic nested quantifier', '(a+)+$'],
    ['star of a plus',            '(x*)*y'],
    ['quantified char class',     '([ab]{2,})+'],
    ['alternation under a star',  '(a|a)*$'],
    ['braced outer quantifier',   '(a+){2,}'],
  ])('refuses %s', (_label, src) => {
    const t0 = Date.now();
    expect(matchRegex('a'.repeat(200) + '!', src)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it.each([
    ['anchored prefix', '^eu-',      'eu-west-1', true],
    ['alternation',     '^(a|b)$',   'b',         true],
    ['simple plus',     '^x+$',      'xxxx',      true],
    ['non-match',       '^eu-',      'us-east-1', false],
  ])('still matches %s', (_l, src, value, want) => {
    expect(matchRegex(value, src)).toBe(want);
  });

  it('does not let a raw regex collide with a glob pattern of the same text', () => {
    matchRegex('gold', '^gold$');
    expect(matchPattern('^gold$', '^gold$')).toBe(true);   // literal equality
    expect(matchPattern('gold', '^gold$')).toBe(false);    // not treated as a regex
  });
});
