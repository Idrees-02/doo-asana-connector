/**
 * Repository-wide privacy scan.
 *
 * The fixtures in this repository were captured from a real Asana workspace
 * and then anonymized. The risk with any such substitution is that it decays:
 * someone recaptures a fixture, or pastes a real gid into a test, and the real
 * data creeps back in one commit at a time.
 *
 * This test makes that a build failure. It scans every git-tracked file — not
 * just `fixtures/`, because the assessment found identifiers in tests and docs
 * too — for the specific values that used to be present, plus the general
 * shapes of things that should never be committed.
 *
 * It is deliberately separate from `npm run secrets:scan`. That scanner looks
 * for CREDENTIALS. This one looks for IDENTITY: names, workspace names, and
 * provider object ids belonging to a real account. Both are needed; neither
 * catches the other's cases.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Values that were genuinely present before anonymization, plus the shapes of
 * things that must never appear. Each carries a `why` so a future failure
 * explains itself rather than just naming a regex.
 */
interface Rule {
  readonly id: string;
  readonly why: string;
  readonly pattern: RegExp;
}

const RULES: readonly Rule[] = [
  {
    id: 'captured-workspace-gid',
    why: 'The gid of the real Asana workspace the fixtures were captured from.',
    pattern: /\b12173001361298\d\d\b/g,
  },
  {
    id: 'captured-project-and-task-gids',
    why: 'Gids of real projects, tasks and stories from the capture workspace.',
    pattern: /\b12173(?:00991|01043|01120|01264)\d{6}\b/g,
  },
  {
    id: 'captured-workspace-name',
    why: 'The default workspace name of the real account used for capture.',
    // Word-boundary anchored so ordinary prose about "my workspace" is fine.
    pattern: /"My workspace"|'My workspace'/g,
  },
  {
    id: 'captured-project-name',
    why: 'The real project name from the capture workspace.',
    pattern: /Idrees's first project|Idrees&#39;s first project/gi,
  },
  {
    id: 'real-asana-permalink',
    why: 'A permalink pointing at a real Asana object. Fixture URLs must use synthetic gids.',
    // app.asana.com links whose ids are NOT in the synthetic 77…/9… ranges.
    pattern: /https:\/\/app\.asana\.com\/1\/(?!77|9)\d{8,}/g,
  },
  {
    id: 'captured-write-task-gid',
    why: 'The gid of a task this session actually created in the real workspace.',
    pattern: /\b12182(?:20|21)\d{9}\b/g,
  },
  {
    id: 'non-reserved-email',
    why: 'Fixtures and tests must use reserved example domains (example.com / example.invalid).',
    pattern:
      /"[A-Za-z0-9._%+-]+@(?!example\.com|example\.invalid|example\.org|example\.net)[A-Za-z0-9.-]+\.[A-Za-z]{2,}"/g,
  },
  {
    id: 'asana-pat-shape',
    why: 'An Asana Personal Access Token. Belongs only in .env, which is gitignored.',
    pattern: /\b[12]\/\d{10,}:[0-9a-f]{20,}\b/g,
  },
  {
    id: 'groq-key-shape',
    why: 'A Groq API key.',
    pattern: /\bgsk_[A-Za-z0-9]{20,}\b/g,
  },
  {
    id: 'jwt-shape',
    why: 'A JSON Web Token.',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    id: 'private-key-block',
    why: 'A private key.',
    pattern: /-{5}BEGIN\s+(?:RSA|EC|OPENSSH|PGP|DSA)?\s*PRIVATE KEY-{5}/g,
  },
];

/**
 * Paths exempt from the scan, each for a stated reason. Kept short on purpose:
 * every exemption is a place the scan cannot protect.
 */
const SKIP = [
  // This file defines the patterns, so it necessarily contains them.
  /^tests\/integration\/privacy\.test\.ts$/,
  // Reference documentation supplied by Asana, not authored here.
  /^Asana-documentation\.pdf$/,
  // Build output and lockfiles: generated, and re-derived from tracked source.
  /^(?:dist|coverage|node_modules)\//,
  /^frontend\/dist\//,
  /^package-lock\.json$/,
  // Local agent tooling, removed from the repository (see
  // THIRD-PARTY-NOTICES.md). The entry stays so a re-added copy cannot slow
  // the scan to a crawl.
  /^claude\//,
];

const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2',
  '.ttf', '.otf', '.pdf', '.zip', '.glb',
]);

const MAX_BYTES = 2_000_000;

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.trim().length > 0)
    .filter((f) => !SKIP.some((re) => re.test(f)))
    .filter((f) => !SKIP_EXTENSIONS.has(extname(f).toLowerCase()));
}

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: Rule;
}

function scan(files: readonly string[]): Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    let contents: string;
    try {
      if (statSync(join(ROOT, file)).size > MAX_BYTES) continue;
      contents = readFileSync(join(ROOT, file), 'utf8');
    } catch {
      continue; // deleted or binary
    }

    const lines = contents.split('\n');
    for (const rule of RULES) {
      for (let i = 0; i < lines.length; i++) {
        rule.pattern.lastIndex = 0;
        if (rule.pattern.test(lines[i] ?? '')) {
          findings.push({ file, line: i + 1, rule });
        }
      }
    }
  }

  return findings;
}

/*
 * Scanned once and shared: `git ls-files` plus a few hundred file reads is not
 * something to repeat per assertion.
 */
const files = trackedFiles();
const findings = scan(files);

describe('repository privacy scan', () => {
  it('scans a meaningful number of tracked files', () => {
    // Guards the guard: a broken skip list that excluded everything would
    // otherwise make this whole file pass vacuously.
    expect(files.length).toBeGreaterThan(50);
  });

  it('contains no real provider or account data anywhere in the repository', () => {
    const report = findings
      .map((f) => `  ${f.file}:${f.line}  [${f.rule.id}] ${f.rule.why}`)
      .join('\n');

    // The message names the rule and the reason, so a future failure is
    // actionable without reading this file.
    expect(findings, `\n${report}\n`).toHaveLength(0);
  });

  it.each(RULES.map((r) => [r.id, r] as const))('finds no match for rule %s', (_id, rule) => {
    expect(findings.filter((f) => f.rule.id === rule.id)).toHaveLength(0);
  });
});

describe('fixtures use the documented synthetic identifiers', () => {
  const fixtureFiles = files.filter((f) => f.startsWith('fixtures/asana/') && f.endsWith('.json'));

  it('covers every fixture', () => {
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(8);
  });

  it.each(fixtureFiles)('%s uses only synthetic 77-prefixed gids', (file) => {
    const contents = readFileSync(join(ROOT, file), 'utf8');
    /*
     * Every gid in a fixture must come from the synthetic range documented in
     * fixtures/asana/README.md: `77` + a kind digit + 12 more. The kind digit
     * is what stops one number meaning "a story" in one file and "a task" in
     * another after a recapture reorders allocation.
     */
    for (const match of contents.matchAll(/"gid":\s*"(\d+)"/g)) {
      expect(match[1]).toMatch(/^77[1-7]\d{12}$/);
    }
  });

  it.each(fixtureFiles)('%s names only synthetic people and places', (file) => {
    const contents = readFileSync(join(ROOT, file), 'utf8');

    for (const match of contents.matchAll(/"name":\s*"([^"]+)"/g)) {
      const name = match[1] ?? '';
      // Every name the capture script can emit, and nothing else. A real name
      // surviving anonymization fails here rather than being committed.
      expect(name).toMatch(
        new RegExp(
          '^(?:' +
            [
              'Synthetic Builder',
              'Synthetic Member \\d+',
              'DOO Synthetic Workspace(?: \\d+)?',
              'Synthetic Project (?:Alpha|Beta|Gamma|Delta|Epsilon|\\d+)',
              'Synthetic Task \\d{3}',
              'Synthetic Section \\d+',
              'Synthetic Tag \\d+',
              // Generic workflow labels carry no identity and are kept as-is.
              'To do|Doing|Done|In progress|Backlog|Untitled section',
            ].join('|') +
            ')$',
        ),
      );
    }
  });

  it.each(fixtureFiles)('%s contains no free-text carried over from the real workspace', (file) => {
    const contents = readFileSync(join(ROOT, file), 'utf8');

    // `notes` and comment `text` are arbitrary user prose, which cannot be
    // reliably de-identified — so the capture script replaces them outright.
    for (const match of contents.matchAll(/"notes":\s*"([^"]*)"/g)) {
      expect(match[1]).toMatch(/^(?:|Synthetic notes\.)$/);
    }
    for (const match of contents.matchAll(/"text":\s*"([^"]+)"/g)) {
      // Either a replaced comment, or a system story whose names were mapped.
      expect(match[1]).toMatch(/^(?:Synthetic comment \d+\.|Synthetic .*)$/);
    }
  });

  it.each(fixtureFiles)('%s uses a reserved email domain', (file) => {
    const contents = readFileSync(join(ROOT, file), 'utf8');
    for (const match of contents.matchAll(/"email":\s*"([^"]+)"/g)) {
      expect(match[1]).toMatch(/@example\.(?:com|invalid|org|net)$/);
    }
  });
});

describe('the demo provider is clearly synthetic too', () => {
  it('uses reserved .invalid addresses for every demo user', () => {
    const seed = readFileSync(join(ROOT, 'src/demo/seed.ts'), 'utf8');

    for (const match of seed.matchAll(/email:\s*'([^']+)'/g)) {
      // .invalid is reserved by RFC 2606 and can never resolve, so demo data
      // cannot accidentally address a real person.
      expect(match[1]).toMatch(/@example\.invalid$/);
    }
  });

  it('keeps demo gids in a range distinct from the captured fixtures', () => {
    const seed = readFileSync(join(ROOT, 'src/demo/seed.ts'), 'utf8');
    for (const match of seed.matchAll(/gid:\s*'(\d{10,})'/g)) {
      // Demo uses 9…, captured fixtures use 77…. A gid in a log is therefore
      // always attributable to one source or the other.
      expect(match[1]).toMatch(/^9/);
    }
  });
});
