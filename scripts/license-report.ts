/**
 * Dependency licence inventory.
 *
 * Walks the installed tree — direct AND transitive, including nested
 * `node_modules` — reads each package's declared licence, and writes
 * THIRD-PARTY-NOTICES.md.
 *
 * Written here rather than pulled in as a dependency for the same reason as
 * `scan-secrets.ts`: adding a licence-checking package to audit the licences
 * of packages is a circularity that also makes the project less
 * clone-and-run. Node's filesystem API is entirely sufficient.
 *
 *   npm run licenses         # rewrite THIRD-PARTY-NOTICES.md
 *   npm run licenses:check   # fail if it is out of date, or a licence is
 *                            # unknown / incompatible with MIT redistribution
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'THIRD-PARTY-NOTICES.md');

interface Entry {
  readonly name: string;
  readonly version: string;
  readonly license: string;
}

/**
 * Licences this project may redistribute under its own MIT terms.
 *
 * MPL-2.0 is included deliberately: it is FILE-level copyleft, so shipping an
 * unmodified MPL package alongside MIT code is permitted. It would stop being
 * permitted if those files were modified in place, which nothing here does.
 */
const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  'BlueOak-1.0.0',
  'Python-2.0',
  'MPL-2.0',
  '(MIT OR CC0-1.0)',
  '(MIT OR Apache-2.0)',
  'Apache-2.0 WITH LLVM-exception',
]);

/** Licences that would make redistribution under MIT unsound. Reported, never ignored. */
function isIncompatible(license: string): boolean {
  return /(?:^|[^L])GPL|AGPL|SSPL|BUSL|CC-BY-NC|Commons Clause|proprietary|UNLICENSED/i.test(
    license,
  );
}

function declaredLicense(pkg: Record<string, unknown>): string {
  const license = pkg['license'];
  if (typeof license === 'string' && license.trim().length > 0) return license.trim();
  if (license !== null && typeof license === 'object' && 'type' in license) {
    const { type } = license;
    return typeof type === 'string' ? type : 'UNKNOWN';
  }
  // The deprecated `licenses` array, still present in a few old packages.
  const legacy = pkg['licenses'];
  if (Array.isArray(legacy)) {
    return legacy.map((l: { type?: string }) => l.type ?? 'UNKNOWN').join(' OR ');
  }
  return 'UNKNOWN';
}

function collect(dir: string, into: Map<string, Entry>): void {
  if (!existsSync(dir)) return;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);

    // Scoped packages nest one level deeper: @scope/name.
    if (entry.name.startsWith('@')) {
      collect(path, into);
      continue;
    }
    if (entry.name === '.bin') continue;

    try {
      const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      // Read defensively: a package.json in the wild may carry any type here,
      // and a directory name is a better fallback than "[object Object]".
      const name = typeof pkg['name'] === 'string' ? pkg['name'] : entry.name;
      const version = typeof pkg['version'] === 'string' ? pkg['version'] : '0.0.0';
      into.set(`${name}@${version}`, { name, version, license: declaredLicense(pkg) });
    } catch {
      // Not a package directory. Keep walking.
    }

    // Nested dependencies, which npm creates on a version conflict.
    collect(join(path, 'node_modules'), into);
  }
}

function render(entries: readonly Entry[]): string {
  const byLicense = new Map<string, Entry[]>();
  for (const entry of entries) {
    const list = byLicense.get(entry.license) ?? [];
    list.push(entry);
    byLicense.set(entry.license, list);
  }

  const summary = [...byLicense.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([license, list]) => `| \`${license}\` | ${list.length} |`)
    .join('\n');

  const detail = [...byLicense.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([license, list]) => {
      const rows = list
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => `| \`${e.name}\` | ${e.version} |`)
        .join('\n');
      return `### ${license}\n\n| Package | Version |\n| --- | --- |\n${rows}\n`;
    })
    .join('\n');

  return `# Third-party licences

<!-- GENERATED FILE — DO NOT EDIT BY HAND.
     Produced by \`npm run licenses\` from the installed dependency tree.
     \`npm run licenses:check\` fails if this file is stale. -->

This project is distributed under the MIT licence (see [\`LICENSE\`](LICENSE)).
It bundles no third-party source: every entry below is an npm dependency
resolved at install time, listed here so the full obligation set is visible
without running a tool.

**${entries.length} packages** across the production and development trees,
including transitive dependencies and nested duplicates.

## Summary

| Licence | Packages |
| --- | --- |
${summary}

Every licence above permits redistribution under MIT terms.

\`MPL-2.0\` (\`lightningcss\`, a transitive dependency of the frontend build
toolchain) is file-level copyleft: shipping the package unmodified alongside
MIT code is permitted, and nothing here modifies its sources. It is a
build-time dependency and does not appear in the shipped bundle.

\`Python-2.0\` (\`argparse\`) and \`CC0-1.0\` (\`mdn-data\`) are likewise
permissive for this use.

## No vendored third-party source

The repository contains no copied or vendored third-party code. An earlier
revision tracked a \`claude/\` directory of third-party Claude Code design
skills; thirteen of those shipped with no licence file at all, which cannot be
redistributed under this repository's MIT declaration. They were unrelated to
the connector — no source file referenced them — and have been removed.

## Detail

${detail}`;
}

function main(): void {
  const check = process.argv.includes('--check');

  const entries = new Map<string, Entry>();
  collect(join(ROOT, 'node_modules'), entries);

  const list = [...entries.values()];
  if (list.length === 0) {
    console.error('No packages found. Run `npm install` first.');
    process.exit(1);
  }

  const unknown = list.filter((e) => e.license === 'UNKNOWN');
  const incompatible = list.filter((e) => isIncompatible(e.license));
  const unlisted = list.filter(
    (e) => !ALLOWED.has(e.license) && e.license !== 'UNKNOWN' && !isIncompatible(e.license),
  );

  for (const [label, group] of [
    ['UNKNOWN licence', unknown],
    ['INCOMPATIBLE with MIT redistribution', incompatible],
    ['not on the reviewed allow-list', unlisted],
  ] as const) {
    if (group.length === 0) continue;
    console.error(`\n${group.length} package(s) ${label}:`);
    for (const e of group) console.error(`  ${e.name}@${e.version} — ${e.license}`);
  }

  // An unknown or copyleft licence is a compliance decision, not a formatting
  // nit: fail rather than quietly writing it into the notices file.
  if (unknown.length > 0 || incompatible.length > 0 || unlisted.length > 0) {
    console.error(
      '\nResolve these before publishing: replace the dependency, or add the licence to ' +
        'ALLOWED in scripts/license-report.ts with a written justification.\n',
    );
    process.exit(1);
  }

  const rendered = render(list);

  if (check) {
    const existing = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';
    if (existing !== rendered) {
      console.error(
        'THIRD-PARTY-NOTICES.md is out of date. Run `npm run licenses` and commit the result.',
      );
      process.exit(1);
    }
    console.log(`licenses:check — clean (${list.length} packages, all permissive)`);
    return;
  }

  writeFileSync(OUTPUT, rendered, 'utf8');
  console.log(`Wrote THIRD-PARTY-NOTICES.md (${list.length} packages, all permissive)`);
}

main();
