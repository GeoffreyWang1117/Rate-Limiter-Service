import { userInfo } from 'os';

/**
 * Points the process at the local dev stack before `src/config` is imported.
 * jest `setupFiles` run before the module registry is populated, so config picks
 * these up. Any of them can be overridden from the outside, which is how CI
 * points the same suite at its own service containers.
 */
process.env.NODE_ENV = 'test';
// LOG_LEVEL is deliberately left unset: the logger goes silent under NODE_ENV=test
// unless one is provided, so a debugging run can turn it back on with LOG_LEVEL=debug.
process.env.REDIS_HOST = process.env.REDIS_HOST ?? '127.0.0.1';
process.env.REDIS_PORT = process.env.REDIS_PORT ?? '6399';
process.env.REDIS_DB = process.env.REDIS_DB ?? '15';
process.env.POSTGRES_HOST = process.env.POSTGRES_HOST ?? '127.0.0.1';
process.env.POSTGRES_PORT = process.env.POSTGRES_PORT ?? '55432';
process.env.POSTGRES_DB = process.env.POSTGRES_DB ?? 'rate_limiter';
process.env.POSTGRES_USER = process.env.POSTGRES_USER ?? userInfo().username;
process.env.POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? '';
