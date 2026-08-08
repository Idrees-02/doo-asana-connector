/**
 * Interactive .env setup.
 *
 *   npm run setup
 *
 * Prompts for an Asana Personal Access Token and writes it to `.env`.
 *
 * Design notes, because they are the point of this script existing:
 *
 *   - Input is HIDDEN while typing, so the token does not end up on screen or
 *     in a screen recording.
 *   - It is read from stdin, never from a command-line argument, so it does
 *     not land in shell history or the process list (where any other user on
 *     the machine could read it via `ps`).
 *   - `.env` is written with mode 0600 — owner read/write only.
 *   - The token is never echoed back, never logged, and never printed on
 *     success. The script confirms by making a real API call instead.
 */

import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');
const EXAMPLE_PATH = join(ROOT, '.env.example');

/** Asana PATs look like `<version>/<numeric gid>:<hex secret>`. */
const PAT_SHAPE = /^\d+\/\d{6,}:[0-9a-f]{16,}$/i;

/**
 * Read a line without echoing it.
 *
 * `readline` has no built-in hidden mode, so the output stream's write is
 * intercepted while the prompt is active.
 */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const output = process.stdout;
    const rl = createInterface({ input: process.stdin, output, terminal: true });

    let muted = false;
    const originalWrite = output.write.bind(output);

    const mutedWrite = (chunk: string): boolean => {
      // Swallow the echoed keystrokes while the prompt is active, but let the
      // prompt text itself and the trailing newline through.
      if (muted && !chunk.includes('\n')) return true;
      return originalWrite(chunk);
    };
    output.write = mutedWrite;

    rl.question(question, (answer) => {
      muted = false;
      output.write = originalWrite;
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });

    muted = true;
  });
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  console.log('\nAsana Connector — environment setup\n');

  if (!existsSync(EXAMPLE_PATH)) {
    console.error('.env.example is missing. Run this from the project root.');
    process.exit(1);
  }

  if (existsSync(ENV_PATH)) {
    const answer = await prompt('.env already exists. Overwrite the token in it? [y/N] ');
    if (!/^y(es)?$/i.test(answer)) {
      console.log('Cancelled. Nothing was changed.\n');
      return;
    }
  }

  console.log('Create a token at: https://app.asana.com/0/my-apps  ->  Create new token');
  console.log('Asana shows it exactly once, so copy it before closing that dialog.');
  console.log('Nothing you type below is displayed, logged, or stored anywhere but .env.\n');

  const token = await promptHidden('Paste your Asana Personal Access Token: ');

  if (token.length === 0) {
    console.log('No token entered. Nothing was changed.');
    console.log('The app runs fine without one — it starts in demo mode.\n');
    return;
  }

  if (!PAT_SHAPE.test(token)) {
    // A warning, not a hard failure: Asana could change the format, and
    // refusing a valid token would be worse than letting the API decide.
    console.log('\n  Warning: that does not look like an Asana PAT.');
    console.log('  Expected shape: <version>/<numeric-gid>:<hex-secret>');

    const proceed = await prompt('  Use it anyway? [y/N] ');
    if (!/^y(es)?$/i.test(proceed)) {
      console.log('Cancelled. Nothing was changed.\n');
      return;
    }
  }

  // Start from .env.example so every documented variable is present, then set
  // only the token line. Any other values already in .env are preserved.
  const base = existsSync(ENV_PATH)
    ? readFileSync(ENV_PATH, 'utf8')
    : readFileSync(EXAMPLE_PATH, 'utf8');

  const updated = base.includes('ASANA_ACCESS_TOKEN=')
    ? base.replace(/^ASANA_ACCESS_TOKEN=.*$/m, `ASANA_ACCESS_TOKEN=${token}`)
    : `${base.trimEnd()}\nASANA_ACCESS_TOKEN=${token}\n`;

  // 0600: owner only. Other accounts on this machine cannot read it.
  writeFileSync(ENV_PATH, updated, { encoding: 'utf8', mode: 0o600 });

  console.log('\nWrote .env (permissions 0600, owner read/write only).');
  console.log('.env is gitignored and blocked by the pre-commit hook.\n');

  console.log('Verifying against Asana…');

  // Import after .env exists so config picks it up.
  const { bootstrap } = await import('../src/index.js');
  const { connector, config } = bootstrap({ silent: true });

  if (config.mode !== 'live') {
    console.log('  The connector did not switch to live mode. Check .env and retry.\n');
    process.exit(1);
  }

  const result = await connector.testConnection();

  if (!result.connected) {
    console.log(`\n  Connection failed: ${result.error?.code ?? 'unknown'}`);
    console.log(`  ${result.error?.message ?? ''}`);
    console.log(`  ${result.error?.guidance ?? ''}\n`);
    process.exit(1);
  }

  // Confirms the token works without ever displaying it.
  console.log(`  Connected as ${result.account?.name ?? 'unknown'} (${result.latencyMs}ms)`);
  console.log(`  Workspaces: ${result.workspaces.map((w) => w.name ?? w.id).join(', ')}`);
  console.log(`  Credential fingerprint: ${result.auth.fingerprint ?? 'none'}`);

  console.log('\nSetup complete. Start the console with:  npm run dev\n');
}

main().catch((error: unknown) => {
  console.error('\nSetup failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
