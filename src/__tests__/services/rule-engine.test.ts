import ruleEngineService from '../../services/rule-engine.service';
import ruleRepository from '../../repositories/rule.repository';
import postgresService from '../../services/postgres.service';
import { RateLimitAlgorithm, DimensionType } from '../../types';

/**
 * Rule matching across every dimension.
 *
 * This is the layer that decides which limit a request is judged against, so a
 * rule that matches too broadly silently governs traffic it was never written
 * for -- and one that matches too narrowly is simply never applied, which looks
 * exactly like everything working.
 */
const PREFIX = 'engine-test';

beforeAll(async () => {
  await postgresService.connect();
});

afterAll(async () => {
  await clear();
  await postgresService.disconnect();
});

async function clear(): Promise<void> {
  await postgresService.query('DELETE FROM rate_limit_rules WHERE name LIKE $1', [
    `${PREFIX}%`,
  ]);
  await postgresService.query('UPDATE rate_limit_rules SET enabled = false');
  ruleEngineService.invalidateCache();
}

beforeEach(clear);

async function given(
  suffix: string,
  dimensionType: DimensionType,
  dimensionPattern: string | undefined,
  priority = 500
): Promise<void> {
  await ruleRepository.create({
    name: `${PREFIX}-${suffix}`,
    algorithm: RateLimitAlgorithm.TOKEN_BUCKET,
    limit: 100,
    windowSeconds: 60,
    dimensionType,
    dimensionPattern,
    priority,
    enabled: true,
  });
  ruleEngineService.invalidateCache();
}

describe('dimension matching', () => {
  it('matches a global rule regardless of context', async () => {
    await given('global', DimensionType.GLOBAL, undefined);
    const result = await ruleEngineService.findMatchingRule({ identifier: 'anyone' });
    expect(result.matched).toBe(true);
  });

  it('matches a user rule against the identifier', async () => {
    await given('user', DimensionType.USER, 'premium:*');

    expect((await ruleEngineService.findMatchingRule({ identifier: 'premium:7' })).matched).toBe(true);
    expect((await ruleEngineService.findMatchingRule({ identifier: 'free:7' })).matched).toBe(false);
  });

  it('matches an IP rule, and declines when the context carries no IP', async () => {
    await given('ip', DimensionType.IP, '10.0.*');

    expect(
      (await ruleEngineService.findMatchingRule({ identifier: 'u', ip: '10.0.4.2' })).matched
    ).toBe(true);
    expect(
      (await ruleEngineService.findMatchingRule({ identifier: 'u', ip: '192.168.1.1' })).matched
    ).toBe(false);
    // A rule scoped to a dimension the request does not carry must not match.
    // Matching anyway would apply an IP limit to traffic with no known IP.
    expect((await ruleEngineService.findMatchingRule({ identifier: 'u' })).matched).toBe(false);
  });

  it('matches an endpoint rule against the path', async () => {
    await given('endpoint', DimensionType.ENDPOINT, '/api/v1/admin/*');

    expect(
      (
        await ruleEngineService.findMatchingRule({
          identifier: 'u',
          endpoint: '/api/v1/admin/keys',
        })
      ).matched
    ).toBe(true);
    expect(
      (
        await ruleEngineService.findMatchingRule({
          identifier: 'u',
          endpoint: '/api/v1/chat',
        })
      ).matched
    ).toBe(false);
  });

  it('matches a custom rule on request metadata by equality', async () => {
    await given('custom-eq', DimensionType.CUSTOM, 'tier=enterprise');

    expect(
      (
        await ruleEngineService.findMatchingRule({
          identifier: 'u',
          metadata: { tier: 'enterprise' },
        })
      ).matched
    ).toBe(true);
    expect(
      (
        await ruleEngineService.findMatchingRule({
          identifier: 'u',
          metadata: { tier: 'free' },
        })
      ).matched
    ).toBe(false);
    expect((await ruleEngineService.findMatchingRule({ identifier: 'u' })).matched).toBe(false);
  });

  it('matches a custom rule on metadata by regex', async () => {
    await given('custom-re', DimensionType.CUSTOM, 'region~^eu-');

    expect(
      (
        await ruleEngineService.findMatchingRule({
          identifier: 'u',
          metadata: { region: 'eu-west-1' },
        })
      ).matched
    ).toBe(true);
    expect(
      (
        await ruleEngineService.findMatchingRule({
          identifier: 'u',
          metadata: { region: 'us-east-1' },
        })
      ).matched
    ).toBe(false);
  });

  it('declines a custom rule whose pattern is malformed rather than throwing', async () => {
    await given('custom-bad', DimensionType.CUSTOM, 'no-operator-here');
    expect(
      (
        await ruleEngineService.findMatchingRule({
          identifier: 'u',
          metadata: { anything: 'x' },
        })
      ).matched
    ).toBe(false);
  });

  it('returns no match, not an error, when nothing applies', async () => {
    const result = await ruleEngineService.findMatchingRule({ identifier: 'nobody' });
    expect(result.matched).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe('priority', () => {
  it('returns the highest-priority match', async () => {
    await given('low', DimensionType.GLOBAL, undefined, 100);
    await given('high', DimensionType.USER, 'vip:*', 900);

    const result = await ruleEngineService.findMatchingRule({ identifier: 'vip:1' });
    expect(result.rule?.name).toBe(`${PREFIX}-high`);
  });

  it('falls through to a lower-priority rule when the specific one does not match', async () => {
    await given('low', DimensionType.GLOBAL, undefined, 100);
    await given('high', DimensionType.USER, 'vip:*', 900);

    const result = await ruleEngineService.findMatchingRule({ identifier: 'regular:1' });
    expect(result.rule?.name).toBe(`${PREFIX}-low`);
  });
});

describe('caching', () => {
  it('serves repeat lookups without re-reading the database', async () => {
    await given('cached', DimensionType.GLOBAL, undefined);
    await ruleEngineService.findMatchingRule({ identifier: 'u' });

    const spy = jest.spyOn(ruleRepository, 'findEnabledRulesByPriority');
    await ruleEngineService.findMatchingRule({ identifier: 'u' });
    await ruleEngineService.findMatchingRule({ identifier: 'u' });

    // Postgres on the decision path would put a network round trip in front of
    // every rate limit check.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('reports cache state and reloads after invalidation', async () => {
    await given('stats', DimensionType.GLOBAL, undefined);
    await ruleEngineService.findMatchingRule({ identifier: 'u' });

    expect(ruleEngineService.getCacheStats().cachedRules).toBeGreaterThan(0);

    ruleEngineService.invalidateCache();
    expect(ruleEngineService.getCacheStats().cachedRules).toBe(0);
    expect(ruleEngineService.getCacheStats().lastUpdated).toBeNull();
  });
});
