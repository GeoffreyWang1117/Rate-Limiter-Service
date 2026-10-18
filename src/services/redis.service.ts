import Redis, { Cluster } from 'ioredis';
import config from '../config';
import logger from '../utils/logger';
import { RedisConnectionError } from '../utils/errors';

/**
 * Either client shape. Every command this service issues exists on both, and
 * the admission keys are hash-tagged so that each multi-key script stays inside
 * one slot -- which is what makes a cluster usable here at all, since a
 * cross-slot script is refused outright rather than merely being slow.
 */
export type RedisLike = Redis | Cluster;

class RedisService {
  private client: RedisLike | null = null;
  private isConnected = false;

  /** True when the configured client is a cluster client. */
  isCluster(): boolean {
    return this.client instanceof Cluster;
  }

  async connect(): Promise<RedisLike> {
    if (this.client && this.isConnected) {
      return this.client;
    }

    const retryStrategy = (times: number): number | null => {
      if (times > config.redis.maxRetries) {
        logger.error('Redis max retries exceeded');
        return null;
      }
      const delay = Math.min(times * config.redis.retryDelay, 3000);
      logger.warn(`Redis reconnecting in ${delay}ms (attempt ${times})`);
      return delay;
    };

    try {
      const seeds = config.redis.clusterNodes;
      this.client = seeds.length
        ? new Cluster(seeds, {
            // Reads go to masters. A replica can lag, and a budget read from a
            // stale replica would admit against tokens that are already spent --
            // the one error this service exists to prevent.
            scaleReads: 'master',
            redisOptions: {
              password: config.redis.password,
              // No `db`: cluster mode has only database 0, and passing one is
              // an error rather than a no-op.
              maxRetriesPerRequest: 3,
            },
            clusterRetryStrategy: retryStrategy,
            enableReadyCheck: true,
          })
        : new Redis({
            host: config.redis.host,
            port: config.redis.port,
            password: config.redis.password,
            db: config.redis.db,
            retryStrategy,
            maxRetriesPerRequest: 3,
            enableReadyCheck: true,
            lazyConnect: false,
          });

      if (seeds.length) {
        logger.info('Redis cluster client configured', {
          seeds: seeds.map((n) => `${n.host}:${n.port}`).join(','),
        });
      }

      this.client.on('connect', () => {
        logger.info('Redis client connected');
        this.isConnected = true;
      });

      this.client.on('ready', () => {
        logger.info('Redis client ready');
      });

      this.client.on('error', (err) => {
        logger.error('Redis client error:', err);
        this.isConnected = false;
      });

      this.client.on('close', () => {
        logger.warn('Redis connection closed');
        this.isConnected = false;
      });

      this.client.on('reconnecting', () => {
        logger.info('Redis client reconnecting');
      });

      await this.client.ping();
      logger.info('Redis connection established successfully');

      return this.client;
    } catch (error) {
      logger.error('Failed to connect to Redis:', error);
      throw new RedisConnectionError('Failed to establish Redis connection');
    }
  }

  getClient(): RedisLike {
    if (!this.client || !this.isConnected) {
      throw new RedisConnectionError('Redis client not connected');
    }
    return this.client;
  }

  /**
   * Every master, for commands that are per-node rather than per-key.
   * `SCRIPT LOAD` is the one that matters: a cluster client sends it to a
   * single node, so pre-warming through it leaves the other masters without
   * the script. On a standalone client this is the client itself.
   */
  masters(): RedisLike[] {
    const client = this.getClient();
    return client instanceof Cluster ? client.nodes('master') : [client];
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      this.isConnected = false;
      logger.info('Redis client disconnected');
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      if (!this.client) return false;
      await this.client.ping();
      return true;
    } catch (error) {
      logger.error('Redis health check failed:', error);
      return false;
    }
  }
}

export default new RedisService();
