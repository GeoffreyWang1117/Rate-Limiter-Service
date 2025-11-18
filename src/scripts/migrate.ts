/**
 * Database Migration Script
 * Run with: npm run db:migrate
 */

import postgresService from '../services/postgres.service';
import { CREATE_TABLES_SQL, DROP_TABLES_SQL } from '../database/schema';
import logger from '../utils/logger';

async function migrate() {
  try {
    logger.info('Starting database migration...');

    // Connect to PostgreSQL
    await postgresService.connect();

    // Get command line argument
    const command = process.argv[2] || 'up';

    if (command === 'up') {
      logger.info('Running migrations (CREATE tables)...');
      await postgresService.query(CREATE_TABLES_SQL);
      logger.info('✓ Migration completed successfully');
    } else if (command === 'down') {
      logger.info('Rolling back migrations (DROP tables)...');
      await postgresService.query(DROP_TABLES_SQL);
      logger.info('✓ Rollback completed successfully');
    } else if (command === 'reset') {
      logger.info('Resetting database (DROP + CREATE)...');
      await postgresService.query(DROP_TABLES_SQL);
      await postgresService.query(CREATE_TABLES_SQL);
      logger.info('✓ Database reset completed successfully');
    } else {
      logger.error(`Unknown command: ${command}`);
      logger.info('Usage: npm run db:migrate [up|down|reset]');
      process.exit(1);
    }

    // Disconnect
    await postgresService.disconnect();
    process.exit(0);
  } catch (error) {
    logger.error('Migration failed:', error);
    await postgresService.disconnect();
    process.exit(1);
  }
}

migrate();
