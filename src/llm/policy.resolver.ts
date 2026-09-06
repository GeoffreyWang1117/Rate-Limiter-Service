import policyRepository, { StoredPolicy } from './policy.repository';
import { AdmissionPolicy, DEFAULT_POLICY } from './types';
import { matchPattern } from '../utils/pattern';
import logger from '../utils/logger';

/**
 * Resolves the policy that governs a (tenant, model) pair.
 *
 * Policies carry glob patterns and a priority, so a deployment can express
 * "everything defaults to this, except tenant acme, except acme on the 70b
 * model" without enumerating the cross product. Highest priority wins; ties go
 * to whichever was created first.
 *
 * Results are cached per resolved pair. Reading the policy table on every
 * admission would put a Postgres round trip on the critical path of a service
 * whose whole purpose is to answer in single-digit milliseconds.
 */
class PolicyResolver {
  private policies: StoredPolicy[] = [];
  private resolved = new Map<string, AdmissionPolicy>();
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  private readonly ttlMs = 30_000;

  async resolve(tenant: string, model: string): Promise<AdmissionPolicy> {
    await this.ensureLoaded();

    const cacheKey = `${tenant} ${model}`;
    const hit = this.resolved.get(cacheKey);
    if (hit) return hit;

    const match = this.policies.find(
      (p) => matchPattern(tenant, p.tenantPattern) && matchPattern(model, p.modelPattern)
    );

    const policy: AdmissionPolicy = match
      ? { ...match, tenant, model }
      : { ...DEFAULT_POLICY, tenant, model };

    this.resolved.set(cacheKey, policy);
    return policy;
  }

  private async ensureLoaded(): Promise<void> {
    if (Date.now() - this.loadedAt < this.ttlMs) return;
    // Collapse a burst of concurrent refreshes into a single query.
    if (this.loading) return this.loading;

    this.loading = (async () => {
      try {
        this.policies = await policyRepository.findEnabledByPriority();
        this.resolved.clear();
        this.loadedAt = Date.now();
        logger.debug('Admission policies loaded', { count: this.policies.length });
      } catch (error) {
        // Serving a slightly stale policy set beats failing admission outright
        // because the control-plane database is briefly unreachable. On a cold
        // cache this leaves the set empty and every lookup falls back to the
        // built-in default, which errs toward the conservative limit.
        logger.error('Failed to load admission policies; serving cached set', error);
        this.loadedAt = Date.now();
      } finally {
        this.loading = null;
      }
    })();

    return this.loading;
  }

  invalidate(): void {
    this.loadedAt = 0;
    this.resolved.clear();
    logger.info('Admission policy cache invalidated');
  }

  stats() {
    return {
      policies: this.policies.length,
      resolvedEntries: this.resolved.size,
      loadedAt: this.loadedAt ? new Date(this.loadedAt).toISOString() : null,
      stale: Date.now() - this.loadedAt >= this.ttlMs,
    };
  }
}

export default new PolicyResolver();
