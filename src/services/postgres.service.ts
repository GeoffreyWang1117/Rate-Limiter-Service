import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import config from '../config';
import logger from '../utils/logger';

class PostgresService {
  private pool: Pool | null = null;
  private isConnected = false;

  async connect(): Promise<Pool> {
    if (this.pool && this.isConnected) {
      return this.pool;
    }

    try {
      this.pool = new Pool({
        host: config.postgres.host,
        port: config.postgres.port,
        database: config.postgres.database,
        user: config.postgres.user,
        password: config.postgres.password,
        max: config.postgres.maxConnections,
        idleTimeoutMillis: config.postgres.idleTimeout,
        connectionTimeoutMillis: 5000,
      });

      // Test connection
      const client = await this.pool.connect();
      await client.query('SELECT NOW()');
      client.release();

      this.isConnected = true;

      this.pool.on('error', (err) => {
        logger.error('Unexpected PostgreSQL pool error:', err);
        this.isConnected = false;
      });

      this.pool.on('connect', () => {
        logger.debug('New PostgreSQL client connected');
      });

      logger.info('PostgreSQL connection pool established', {
        host: config.postgres.host,
        port: config.postgres.port,
        database: config.postgres.database,
      });

      return this.pool;
    } catch (error) {
      logger.error('Failed to connect to PostgreSQL:', error);
      throw new Error('Failed to establish PostgreSQL connection');
    }
  }

  getPool(): Pool {
    if (!this.pool || !this.isConnected) {
      throw new Error('PostgreSQL pool not initialized');
    }
    return this.pool;
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const pool = this.getPool();
    const start = Date.now();

    try {
      const result = await pool.query<T>(text, params);
      const duration = Date.now() - start;

      logger.debug('Executed PostgreSQL query', {
        query: text,
        duration: `${duration}ms`,
        rows: result.rowCount,
      });

      return result;
    } catch (error) {
      logger.error('PostgreSQL query error:', {
        query: text,
        error,
      });
      throw error;
    }
  }

  async getClient(): Promise<PoolClient> {
    const pool = this.getPool();
    return pool.connect();
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.isConnected = false;
      logger.info('PostgreSQL pool disconnected');
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      if (!this.pool) return false;
      await this.query('SELECT 1');
      return true;
    } catch (error) {
      logger.error('PostgreSQL health check failed:', error);
      return false;
    }
  }
}

export default new PostgresService();
