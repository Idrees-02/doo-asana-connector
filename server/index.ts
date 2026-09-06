/**
 * API server entry point.
 *
 * Boots the connector, mounts the HTTP adapter, and starts listening. Kept
 * deliberately small: everything interesting lives in the connector or in
 * `app.ts`.
 */

import { bootstrap } from '../src/index.js';
import { createApp } from './app.js';
import { InsecureMcpConfigurationError } from '../src/runtime/mcp-security.js';

function main(): void {
  const runtime = bootstrap();

  /*
   * `createApp` mounts /mcp, which refuses to build for any configuration
   * that would expose an unauthenticated endpoint. Catching it here only to
   * print the remediation legibly — the process still exits non-zero, and
   * nothing binds a socket.
   */
  let app;
  try {
    ({ app } = createApp(runtime));
  } catch (error) {
    if (error instanceof InsecureMcpConfigurationError) {
      process.stderr.write(`\n${error.message}\n\n`);
      process.exit(1);
    }
    throw error;
  }

  const { config, logger } = runtime;

  // Bound explicitly rather than to every interface by default: in
  // development this keeps the API off the local network, which is also what
  // makes the unauthenticated local MCP mode safe to offer.
  const server = app.listen(config.server.port, config.server.host, () => {
    logger.info('API listening', {
      host: config.server.host,
      port: config.server.port,
      externallyBound: config.server.externallyBound,
      mode: config.mode,
      cors: config.server.corsOrigin,
    });

    // Startup banner on stderr, so piping stdout stays clean.
    process.stderr.write(
      [
        '',
        '  Asana Connector API',
        `  http://localhost:${config.server.port}`,
        `  mode: ${config.mode.toUpperCase()} — ${config.modeReason}`,
        config.mode === 'demo'
          ? '  Demo data is synthetic and clearly labelled in the console.'
          : '  Live Asana data. Write actions affect your real workspace.',
        '',
      ].join('\n'),
    );
  });

  // Graceful shutdown, so in-flight requests are not severed mid-write.
  const shutdown = (signal: string): void => {
    logger.info('Shutting down', { signal });
    server.close(() => process.exit(0));
    // Do not hang forever if a connection refuses to close.
    setTimeout(() => process.exit(1), 5_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
