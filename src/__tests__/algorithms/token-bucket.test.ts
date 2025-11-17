import { TokenBucketAlgorithm } from '../../algorithms/token-bucket';
import redisService from '../../services/redis.service';

jest.mock('../../services/redis.service');

describe('TokenBucketAlgorithm', () => {
  let algorithm: TokenBucketAlgorithm;
  let mockRedis: any;

  beforeEach(() => {
    mockRedis = {
      eval: jest.fn(),
      evalsha: jest.fn(),
      script: jest.fn(),
      del: jest.fn(),
      get: jest.fn(),
      ttl: jest.fn(),
    };

    (redisService.getClient as jest.Mock).mockReturnValue(mockRedis);
    algorithm = new TokenBucketAlgorithm();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('check', () => {
    it('should allow request when tokens are available', async () => {
      // Mock Redis response: [allowed, remaining, resetAt]
      mockRedis.eval.mockResolvedValue([1, 9, Date.now() + 60000]);

      const result = await algorithm.check('test-key', 10, 60);

      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(10);
      expect(result.remaining).toBe(9);
      expect(mockRedis.eval).toHaveBeenCalled();
    });

    it('should block request when tokens are exhausted', async () => {
      const now = Date.now();
      // Mock Redis response: [blocked, remaining, resetAt, retryAfter]
      mockRedis.eval.mockResolvedValue([0, 0, now + 60000, 5]);

      const result = await algorithm.check('test-key', 10, 60);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBe(5);
    });
  });

  describe('reset', () => {
    it('should delete rate limit keys', async () => {
      mockRedis.del.mockResolvedValue(2);

      await algorithm.reset('test-key');

      expect(mockRedis.del).toHaveBeenCalledWith(
        'rate_limit:token_bucket:test-key:tokens',
        'rate_limit:token_bucket:test-key:timestamp'
      );
    });
  });

  describe('getStats', () => {
    it('should return current stats', async () => {
      const now = Date.now();
      mockRedis.get.mockResolvedValueOnce('5'); // tokens
      mockRedis.get.mockResolvedValueOnce(now.toString()); // timestamp
      mockRedis.ttl.mockResolvedValue(30);

      const stats = await algorithm.getStats('test-key');

      expect(stats).not.toBeNull();
      expect(stats?.count).toBe(5);
    });

    it('should return null when no stats exist', async () => {
      mockRedis.get.mockResolvedValueOnce(null);
      mockRedis.get.mockResolvedValueOnce(null);

      const stats = await algorithm.getStats('test-key');

      expect(stats).toBeNull();
    });
  });
});
