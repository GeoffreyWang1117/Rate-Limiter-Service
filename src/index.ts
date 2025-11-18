import { createApp } from './app';
import config from './config';
import logger from './utils/logger';
import redisService from './services/redis.service';
import postgresService from './services/postgres.service';

async function bootstrap() {
  try {
    // Connect to Redis
    logger.info('Connecting to Redis...');
    await redisService.connect();

    // Connect to PostgreSQL
    logger.info('Connecting to PostgreSQL...');
    await postgresService.connect();

    // Create Express app
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

      // Force shutdown after 30 seconds
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 30000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    logger.error('Failed to start application:', error);
    process.exit(1);
  }
}

bootstrap();
