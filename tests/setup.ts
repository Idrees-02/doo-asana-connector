/**
 * Global test setup.
 *
 * Deliberately does NOT read or require any real credential. Every test runs
 * against mocked HTTP or the demo provider, so the suite is safe to run on a
 * fresh clone with no `.env` — which is exactly how CI and a reviewer run it.
 */

import { beforeEach } from 'vitest';
import { resetConfigCache } from '../src/config.js';

beforeEach(() => {
  // Config is cached per-process; clear it so each test can build its own.
  resetConfigCache();
});
