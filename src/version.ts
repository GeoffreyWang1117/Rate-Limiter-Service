import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The running build's version, read from package.json rather than written out
 * twice.
 *
 * Two files used to carry the literal '2.0.0' while package.json said 3.0.0, so
 * /health and the root endpoint both misidentified the build. The relative path
 * is the same from `src/` under ts-jest and from `dist/` in the image, and the
 * Dockerfile copies package.json next to dist for exactly this kind of lookup.
 */
function readVersion(): string {
  try {
    const pkg = readFileSync(join(__dirname, '..', 'package.json'), 'utf8');
    return (JSON.parse(pkg) as { version?: string }).version ?? 'unknown';
  } catch {
    // A missing package.json is not a reason to refuse to start.
    return 'unknown';
  }
}

export const VERSION = readVersion();
