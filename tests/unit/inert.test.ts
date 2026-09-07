/**
 * The test suite must give a secret scanner nothing to report.
 *
 * An external assessment raised this as a MEDIUM finding:
 *
 *   "The evidence lists numerous credential_assignment matches, but values
 *    were redacted before review and therefore cannot be conclusively
 *    classified."
 *
 * Every one of those 43 matches was an inert test literal. But a reviewer
 * receiving them redacted cannot know that, and "trust us, they're fake" is
 * not a disposition. So the suite stopped producing them: credential-shaped
 * values are built by `inert()`, which makes them variable references rather
 * than literals assigned to credential-shaped keys.
 *
 * This test stops that regressing — and, just as importantly, stops anyone
 * reaching for a suppression comment instead.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { INERT_PREFIX, inert } from '../helpers/inert.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const testFiles = execFileSync('git', ['ls-files', 'tests', 'frontend/src/test'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));

/** The rule a third-party scanner applies: a literal on a credential-shaped key. */
const CREDENTIAL_ASSIGNMENT =
  /\b(?:access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|auth[_-]?token|token|password|secret|client[_-]?secret|accessToken|refreshToken|authToken|clientSecret)\s*[:=]\s*['"`]([^'"`\s]{6,})['"`]/gi;

describe('inert()', () => {
  it('marks its output unmistakably', () => {
    expect(inert('anything')).toBe(`${INERT_PREFIX}anything`);
  });

  it('keeps distinct labels distinct, so tests can tell values apart', () => {
    expect(inert('stale')).not.toBe(inert('refreshed'));
  });

  it('is long enough to exercise redaction and token-shaped code paths', () => {
    expect(inert('x').length).toBeGreaterThan(16);
  });
});

describe('the test suite produces no credential-assignment matches', () => {
  it('covers a meaningful number of test files', () => {
    // Guards the guard: an empty file list would make this pass vacuously.
    expect(testFiles.length).toBeGreaterThan(10);
  });

  it.each(testFiles)('%s assigns no credential-shaped literal', (file) => {
    const contents = readFileSync(join(ROOT, file), 'utf8');
    const matches = [...contents.matchAll(CREDENTIAL_ASSIGNMENT)].map((m) => m[1]);

    expect(
      matches,
      `\nUse inert('label') instead of a literal:\n${matches.map((m) => `  ${m}`).join('\n')}\n`,
    ).toEqual([]);
  });

  it('suppresses nothing — there is nothing to suppress', () => {
    /*
     * A suppression comment hides a match without answering the question a
     * reviewer is actually asking. If one appears, the right fix is to stop
     * producing the match.
     *
     * This file is exempt from its own rule because it necessarily names the
     * marker in order to look for it — the same exemption
     * `tests/integration/privacy.test.ts` takes for the patterns it defines.
     */
    const marker = ['secrets', 'scan', 'ignore'].join('-');
    const suppressed = testFiles
      .filter((f) => !f.endsWith('tests/unit/inert.test.ts'))
      .filter((f) => readFileSync(join(ROOT, f), 'utf8').includes(marker));

    expect(suppressed).toEqual([]);
  });
});
