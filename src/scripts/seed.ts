import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { logger } from '../shared/logger/index.js';
import { seedDatabase } from './seed-core.js';

connectDatabase()
  .then(() => seedDatabase())
  .then(() => disconnectDatabase())
  .catch((err) => {
    logger.error('Seed failed', { error: err });
    process.exit(1);
  });
