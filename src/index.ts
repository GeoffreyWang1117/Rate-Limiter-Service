import { createApp } from './app';
import config from './config';
import logger from './utils/logger';
import redisService from './services/redis.service';
import postgresService from './services/postgres.service';
import { AlgorithmFactory } from './algorithms';
import admissionService from './llm/admission.service';

async function bootstrap() {
  try {
    // Connect to Redis
    logger.info('Connecting to Redis...');
    await redisService.connect();

    // Connect to PostgreSQL
    logger.info('Connecting to PostgreSQL...');
    await postgresService.connect();

    // Load every Lua script into the Redis script cache before accepting
    // traffic. Otherwise the first request of each kind pays to ship a script
    // body, which shows up as a latency spike on exactly the requests a fresh
    // replica sees right after a deploy.
    await Promise.all([AlgorithmFactory.warmAll(), admissionService.warm()]);
    logger.info('Lua scripts loaded into Redis script cache');

    const app = createApp();

    // Start server
    const server = app.listen(config.server.port, config.server.host, () => {
      logger.info(`Rate Limiter Service started`, {
        host: config.server.host,
        port: config.server.port,
        env: config.server.env,
        redis: `${config.redis.host}:${config.redis.port}`,
      });
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`${signal} received, starting graceful shutdown`);

      server.close(async () => {
        logger.info('HTTP server closed');

        try {
          await redisService.disconnect();
          logger.info('Redis disconnected');

          await postgresService.disconnect();
          logger.info('PostgreSQL disconnected');

          process.exit(0);
        } catch (error) {
          logger.error('Error during shutdown:', error);
          process.exit(1);
        }
      });

      // Backstop: if in-flight requests never drain, do not hang forever. unref()
      // so this timer alone cannot keep the process alive once shutdown is clean.
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 30000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    logger.error('Failed to start application:', error);
    process.exit(1);
  }
}

bootstrap();
