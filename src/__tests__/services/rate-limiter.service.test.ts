import rateLimiterService from '../../services/rate-limiter.service';
import { AlgorithmFactory } from '../../algorithms';
import { RateLimitAlgorithm } from '../../types';

jest.mock('../../algorithms');

describe('RateLimiterService', () => {
  let mockAlgorithm: any;

  beforeEach(() => {
    mockAlgorithm = {
      check: jest.fn(),
      reset: jest.fn(),
      getStats: jest.fn(),
    };

    (AlgorithmFactory.getAlgorithm as jest.Mock).mockReturnValue(mockAlgorithm);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('check', () => {
    it('should check rate limit and return result', async () => {
      const mockResult = {
        allowed: true,
        limit: 100,
        remaining: 99,
        resetAt: Date.now() + 60000,
      };

      mockAlgorithm.check.mockResolvedValue(mockResult);

      const result = await rateLimiterService.check(
        { key: 'user:123', identifier: '123' },
        RateLimitAlgorithm.TOKEN_BUCKET,
        100,
        60
      );

      expect(result).toEqual(mockResult);
      expect(AlgorithmFactory.getAlgorithm).toHaveBeenCalledWith(
        RateLimitAlgorithm.TOKEN_BUCKET
      );
      expect(mockAlgorithm.check).toHaveBeenCalledWith('user:123', 100, 60);
    });

    it('should use default values when not provided', async () => {
      const mockResult = {
        allowed: true,
        limit: 1000,
        remaining: 999,
        resetAt: Date.now() + 60000,
      };

      mockAlgorithm.check.mockResolvedValue(mockResult);

      await rateLimiterService.check({ key: 'user:123', identifier: '123' });

      expect(mockAlgorithm.check).toHaveBeenCalled();
    });
  });

  describe('reset', () => {
    it('should reset rate limit for key', async () => {
      mockAlgorithm.reset.mockResolvedValue(undefined);

      await rateLimiterService.reset('user:123', RateLimitAlgorithm.TOKEN_BUCKET);

      expect(mockAlgorithm.reset).toHaveBeenCalledWith('user:123');
    });
  });

  describe('getStats', () => {
    it('should get stats for key', async () => {
      const mockStats = { count: 50, resetAt: Date.now() + 30000 };
      mockAlgorithm.getStats.mockResolvedValue(mockStats);

      const stats = await rateLimiterService.getStats(
        'user:123',
        RateLimitAlgorithm.TOKEN_BUCKET
      );

      expect(stats).toEqual(mockStats);
      expect(mockAlgorithm.getStats).toHaveBeenCalledWith('user:123');
    });
  });
});
