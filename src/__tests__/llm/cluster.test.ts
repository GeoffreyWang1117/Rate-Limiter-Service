import { Cluster } from 'ioredis';
import admission from '../../llm/admission.service';
import redisService from '../../services/redis.service';
import { AdmissionPolicy, DEFAULT_POLICY } from '../../llm/types';

/**
 * Redis Cluster, against a real cluster.
 *
 * Until these tests existed, "keys carry hash tags so that multi-key scripts
 * stay in one slot" was a claim about naming that nothing had checked. It is
 * not a performance claim: a Lua script whose keys span slots is *refused* with
 * CROSSSLOT, so on a cluster the layout is either correct or the service does
 * not function. Those two outcomes looked identical from inside this
 * repository, which is the gap these close.
 *
 * Skipped unless REDIS_CLUSTER_NODES points at a cluster, so the default suite
 * and CI are unaffected. Bring one up with `./scripts/cluster.sh up` and run
 * `npm run test:cluster`.
 */
const NODES = process.env.REDIS_CLUSTER_NODES;
const describeCluster = NODES ? describe : describe.skip;

const policy = (over: Partial<AdmissionPolicy> = {}): AdmissionPolicy => ({
  ...DEFAULT_POLICY,
  tenant: 'acme',
  model: 'cluster-model',
  scope: 'acme|cluster-model',
  tokensPerMinute: 100_000,
  ...over,
});

/** The suffixes a single admission decision touches. */
const SUFFIXES = ['tpm', 'tpm:ts', 'rpm', 'rpm:ts', 'leases', 'res', 'stats'];

describeCluster('Redis Cluster', () => {
  let client: Cluster;
  /** slot -> owning master, as `host:port`. */
  let owners: Array<{ from: number; to: number; node: string }>;

  beforeAll(async () => {
    await redisService.connect();
    client = redisService.getClient() as Cluster;

    // CLUSTER NODES, parsed once: `<id> <ip:port@bus> <flags> ... <slot-range>`.
    const master = redisService.masters()[0];
    const raw = (await master.cluster('NODES')) as string;
    owners = raw
      .split('\n')
      .filter((line) => line.includes('master') && /\s\d+-\d+\s*$/.test(line))
      .map((line) => {
        const f = line.split(/\s+/);
        const [from, to] = f[f.length - 1].split('-').map(Number);
        return { from, to, node: f[1].split('@')[0] };
      });
  });

  afterAll(async () => {
    await redisService.disconnect();
  });

  beforeEach(async () => {
    await Promise.all(redisService.masters().map((n) => n.flushdb()));
  });

  const ownerOf = async (key: string): Promise<string> => {
    const slot = (await redisService.masters()[0].cluster('KEYSLOT', key)) as number;
    const hit = owners.find((o) => slot >= o.from && slot <= o.to);
    if (!hit) throw new Error(`no master owns slot ${slot} for ${key}`);
    return hit.node;
  };

  it('is actually a cluster, not a single node answering', async () => {
    expect(redisService.isCluster()).toBe(true);
    expect(redisService.masters().length).toBeGreaterThan(1);
  });

  it('places every key of one tenant and model in a single slot', async () => {
    const node = redisService.masters()[0];
    const slots = await Promise.all(
      SUFFIXES.map((s) => node.cluster('KEYSLOT', `llm:{acme|gpt-4}:${s}`))
    );
    expect(new Set(slots).size).toBe(1);
  });

  it('refuses a multi-key script whose keys are not tagged alike', async () => {
    // The counterfactual. Without the shared tag the admission script would not
    // merely be slower on a cluster -- this is what it would do instead.
    await expect(
      client.eval("return redis.call('GET', KEYS[1])", 2, 'llm:acme:tpm', 'llm:other:tpm')
    ).rejects.toThrow(/CROSSSLOT/i);
  });

  it('runs reserve and commit for tenants that live on different masters', async () => {
    // Chosen so the pairs hash into different slot ranges; asserted, not assumed,
    // so a change to the key format that collapses them onto one shard fails here
    // rather than quietly making this test prove nothing.
    const tenants = ['acme', 'beta', 'delta'];
    const nodes = await Promise.all(
      tenants.map((t) => ownerOf(`llm:{${t}|cluster-model}:tpm`))
    );
    expect(new Set(nodes).size).toBeGreaterThan(1);

    for (const tenant of tenants) {
      const p = policy({ tenant, scope: `${tenant}|cluster-model` });
      const reserved = await admission.reserve(
        { tenant, model: 'cluster-model', promptTokens: 900, maxOutputTokens: 512 },
        p
      );
      expect(reserved.decision).toBe('admit');

      const committed = await admission.commit(
        {
          tenant,
          model: 'cluster-model',
          reservationId: reserved.reservationId as string,
          promptTokens: 900,
          outputTokens: 200,
        },
        p
      );
      expect(committed.status).toBe('committed');
    }
  });

  it('keeps each tenant budget on its own shard rather than sharing one', async () => {
    // Spending one tenant's budget must not move another's. On a cluster this
    // also means the two counters are on different machines, so the guarantee
    // rests on key routing rather than on both reads hitting the same server.
    const spend = async (tenant: string) => {
      const p = policy({ tenant, scope: `${tenant}|cluster-model`, tokensPerMinute: 5_000 });
      return admission.reserve(
        { tenant, model: 'cluster-model', promptTokens: 900, maxOutputTokens: 512 },
        p
      );
    };
    const first = await spend('acme');
    const second = await spend('delta');
    expect(first.decision).toBe('admit');
    expect(second.decision).toBe('admit');
    expect(second.tokensRemaining).toBe(first.tokensRemaining);
  });

  it('survives a script cache flush on every node', async () => {
    // SCRIPT FLUSH is per node. The NOSCRIPT path has to work on whichever
    // shard the next request routes to, not just the one the client happened
    // to load the script through.
    await Promise.all(redisService.masters().map((n) => n.script('FLUSH')));
    const p = policy({ tenant: 'beta', scope: 'beta|cluster-model' });
    const result = await admission.reserve(
      { tenant: 'beta', model: 'cluster-model', promptTokens: 100, maxOutputTokens: 100 },
      p
    );
    expect(result.decision).toBe('admit');
  });
});
