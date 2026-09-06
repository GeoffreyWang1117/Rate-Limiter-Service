import winston from 'winston';
import config from '../config';

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  config.logging.format === 'json'
    ? winston.format.json()
    : winston.format.printf(({ timestamp, level, message, ...meta }) => {
        return `${timestamp} [${level.toUpperCase()}]: ${message} ${
          Object.keys(meta).length ? JSON.stringify(meta) : ''
        }`;
      })
);

const logger = winston.createLogger({
  level: config.logging.level,
  format: logFormat,
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), logFormat),
      // Several tests deliberately drive error paths. Printing their stack
      // traces buries the actual test results, and a reader cannot tell an
      // expected error from a real one. LOG_LEVEL still overrides this when a
      // failing test needs to be debugged.
      silent: config.server.env === 'test' && !process.env.LOG_LEVEL,
    }),
  ],
});

export default logger;
