/**
 * Dependency-free secret scanner.
 *
 * Runs in CI and (optionally) as a pre-commit hook. Deliberately has no
 * external binary dependency — the project must stay clone-and-run with
 * nothing but `npm install`, so `gitleaks` is not an option here.
 *
 * Scans git-tracked + staged files for credential patterns, with particular
 * attention to the Asana Personal Access Token format.
 *
 *   npm run secrets:scan            # scan tracked files
 *   npm run secrets:scan -- --staged  # scan staged changes only
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

interface Rule {
  readonly id: string;
  readonly description: string;
  readonly pattern: RegExp;
}

/**
 * Patterns are assembled from fragments so that this file does not match
 * its own rules when it is itself scanned.
 */
const RULES: readonly Rule[] = [
  {
    id: 'asana-pat',
    description: 'Asana Personal Access Token',
    // e.g. 1/<user-gid>:<hex-secret>
    pattern: new RegExp(String.raw`\b1\/\d{10,}:[0-9a-f]{20,}\b`, 'g'),
  },
  {
    id: 'asana-oauth-secret',
    description: 'Asana OAuth client secret assignment',
    pattern: new RegExp(
      String.raw`(?:client[_-]?secret)\s*[:=]\s*['"\x60]([^'"\x60\s]{12,})['"\x60]`,
      'gi',
    ),
  },
  {
    id: 'bearer-token',
    description: 'Hard-coded bearer token',
    pattern: new RegExp(String.raw`\bBearer\s+[A-Za-z0-9._\-\/+]{24,}`, 'g'),
  },
  {
    id: 'generic-credential',
    description: 'Credential-looking assignment with a literal value',
    pattern: new RegExp(
      String.raw`\b(?:access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|auth[_-]?token|password|passwd)\s*[:=]\s*['"\x60]([^'"\x60\s]{8,})['"\x60]`,
      'gi',
    ),
  },
  {
    id: 'private-key',
    description: 'Private key block',
    pattern: new RegExp(String.raw`-{5}BEGIN\s+(?:RSA|EC|OPENSSH|PGP|DSA)?\s*PRIVATE KEY-{5}`, 'g'),
  },
  {
    id: 'aws-access-key',
    description: 'AWS access key id',
    pattern: new RegExp(String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`, 'g'),
  },
];

/**
 * Values that look like credentials but are obviously inert. Anything matching
 * one of these is not reported.
 */
const PLACEHOLDER_HINTS: readonly RegExp[] = [
  /^(?:x{3,}|\*{3,}|\.{3,}|-{3,})$/i,
  /placeholder|example|your[_-]?|dummy|sample|redacted|changeme|replace[_-]?me|fake|test[_-]?only|<[^>]+>|\$\{[^}]+\}/i,
  /^(?:abcdef|123456|deadbeef|null|undefined|true|false|none|empty)/i,
];

/** Files never scanned: placeholders live here by design, or content is generated. */
const SKIP_PATHS: readonly RegExp[] = [
  /^\.env\.example$/,
  /^scripts\/scan-secrets\.ts$/, // this file defines the patterns
  /^package-lock\.json$/,
  /^(?:dist|node_modules|coverage)\//,
  /^docs\/SECURITY\.md$/,
];

const SKIP_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.svg',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.pdf',
  '.zip',
  '.lock',
]);

const MAX_FILE_BYTES = 2_000_000;

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly ruleId: string;
  readonly description: string;
  readonly excerpt: string;
}

function listFiles(stagedOnly: boolean): string[] {
  const args = stagedOnly
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACM']
    : ['ls-files'];
  const out = execFileSync('git', args, { encoding: 'utf8' });
  return out.split('\n').filter((f) => f.trim().length > 0);
}

function shouldSkip(file: string): boolean {
  if (SKIP_PATHS.some((re) => re.test(file))) return true;
  if (SKIP_EXTENSIONS.has(extname(file).toLowerCase())) return true;
  return false;
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_HINTS.some((re) => re.test(value));
}

/** Show that something matched without reprinting the secret itself. */
function maskExcerpt(match: string): string {
  const head = match.slice(0, 4);
  return `${head}${'*'.repeat(Math.max(0, Math.min(match.length - 4, 24)))} (${match.length} chars)`;
}

function scanFile(file: string): Finding[] {
  let contents: string;
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return [];
    contents = readFileSync(file, 'utf8');
  } catch {
    return []; // deleted, binary, or unreadable — nothing to scan
  }

  const findings: Finding[] = [];
  const lines = contents.split('\n');

  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      // Honour an explicit reviewer escape hatch.
      if (line.includes('secrets-scan-ignore')) continue;

      rule.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.pattern.exec(line)) !== null) {
        const captured = match[1] ?? match[0];
        if (isPlaceholder(captured)) continue;
        findings.push({
          file,
          line: i + 1,
          ruleId: rule.id,
          description: rule.description,
          excerpt: maskExcerpt(captured),
        });
        if (match[0].length === 0) rule.pattern.lastIndex++; // guard against zero-width loops
      }
    }
  }

  return findings;
}

function main(): void {
  const stagedOnly = process.argv.includes('--staged');
  const files = listFiles(stagedOnly).filter((f) => !shouldSkip(f));

  const findings = files.flatMap(scanFile);

  if (findings.length === 0) {
    console.log(
      `secrets:scan — clean (${files.length} file${files.length === 1 ? '' : 's'} scanned${stagedOnly ? ', staged only' : ''})`,
    );
    return;
  }

  console.error(`\nsecrets:scan — ${findings.length} potential secret(s) found:\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.ruleId}] ${f.description}`);
    console.error(`    match: ${f.excerpt}\n`);
  }
  console.error('Remove these before committing. Real credentials belong in .env (gitignored).');
  console.error('If a match is a false positive, append the comment: secrets-scan-ignore\n');
  process.exit(1);
}

main();
