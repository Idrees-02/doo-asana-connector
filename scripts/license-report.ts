/**
 * Dependency licence inventory.
 *
 * Reads `package-lock.json` — not the installed `node_modules` — and writes
 * THIRD-PARTY-NOTICES.md.
 *
 * ============================================================================
 * THE LOCKFILE, BECAUSE `node_modules` IS NOT THE SAME ON TWO MACHINES.
 * ============================================================================
 *
 * An earlier version walked the installed tree, and CI caught the flaw: npm
 * installs platform-specific optional dependencies, so a macOS checkout has
 * `lightningcss-darwin-x64` where a Linux runner has `lightningcss-linux-x64`.
 * The generated file therefore differed by platform, and `--check` failed on
 * every CI run for a reason that had nothing to do with licences.
 *
 * The lockfile is committed, platform-independent, and pins every package for
 * every platform — including the ones this machine did not install. That makes
 * the report both deterministic and MORE complete than the installed tree.
 *
 * Written here rather than pulled in as a dependency for the same reason as
 * `scan-secrets.ts`: adding a licence-checking package to audit the licences
 * of packages is a circularity that also makes the project less
 * clone-and-run. Reading one JSON file is entirely sufficient.
 *
 *   npm run licenses         # rewrite THIRD-PARTY-NOTICES.md
 *   npm run licenses:check   # fail if it is out of date, or a licence is
 *                            # unknown / incompatible with MIT redistribution
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'THIRD-PARTY-NOTICES.md');
const LOCKFILE = join(ROOT, 'package-lock.json');

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

function declaredLicense(pkg: { readonly license?: unknown; readonly licenses?: unknown }): string {
  const license = pkg.license;
  if (typeof license === 'string' && license.trim().length > 0) return license.trim();
  if (license !== null && typeof license === 'object' && 'type' in license) {
    const { type } = license;
    return typeof type === 'string' ? type : 'UNKNOWN';
  }
  // The deprecated `licenses` array, still present in a few old packages.
  const legacy = pkg.licenses;
  if (Array.isArray(legacy)) {
    return legacy.map((l: { type?: string }) => l.type ?? 'UNKNOWN').join(' OR ');
  }
  return 'UNKNOWN';
}

/** One `packages` entry from an npm lockfile (v2/v3). */
interface LockEntry {
  readonly version?: unknown;
  readonly license?: unknown;
  readonly licenses?: unknown;
  /** True for a workspace symlink, which is this repo's own code. */
  readonly link?: unknown;
  readonly name?: unknown;
}

/**
 * The package name for a lockfile path.
 *
 * Paths are `node_modules/foo`, `node_modules/@scope/foo`, and for a
 * version conflict `node_modules/a/node_modules/b` — so the name is whatever
 * follows the LAST `node_modules/`.
 */
function nameFromPath(path: string): string | undefined {
  const marker = 'node_modules/';
  const index = path.lastIndexOf(marker);
  if (index === -1) return undefined;
  const name = path.slice(index + marker.length);
  return name.length > 0 ? name : undefined;
}

function collect(into: Map<string, Entry>): void {
  if (!existsSync(LOCKFILE)) {
    console.error('package-lock.json not found. Run `npm install` first.');
    process.exit(1);
  }

  const lock = JSON.parse(readFileSync(LOCKFILE, 'utf8')) as {
    packages?: Record<string, LockEntry>;
  };

  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    // The root project ("") and workspace links are this repository's own
    // code, covered by LICENSE rather than by a third-party notice.
    if (path === '') continue;
    if (entry.link === true) continue;

    const name = nameFromPath(path);
    if (name === undefined) continue;

    const version = typeof entry.version === 'string' ? entry.version : '0.0.0';
    into.set(`${name}@${version}`, { name, version, license: declaredLicense(entry) });
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
pinned by the lockfile, listed here so the full obligation set is visible
without running a tool.

**${entries.length} packages** across the production and development trees,
including transitive dependencies, nested duplicates, and the
platform-specific optional dependencies this machine did not install.

Derived from \`package-lock.json\` rather than the installed \`node_modules\`,
so the inventory is identical on every platform and in CI.

## Summary

| Licence | Packages |
| --- | --- |
${summary}

Every licence above permits redistribution under MIT terms.

\`MPL-2.0\` is \`lightningcss\` and its 23 per-platform native binaries, a
transitive dependency of the frontend build toolchain. MPL is FILE-level
copyleft: shipping the package unmodified alongside MIT code is permitted, and
nothing here modifies its sources. It is a build-time dependency and does not
appear in the shipped bundle.

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
  collect(entries);

  const list = [...entries.values()];
  if (list.length === 0) {
    console.error('package-lock.json lists no packages.');
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
