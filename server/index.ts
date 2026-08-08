/**
 * API server entry point.
 *
 * Boots the connector, mounts the HTTP adapter, and starts listening. Kept
 * deliberately small: everything interesting lives in the connector or in
 * `app.ts`.
 */

import { bootstrap } from '../src/index.js';
import { createApp } from './app.js';

function main(): void {
  const runtime = bootstrap();
  const { app } = createApp(runtime);
  const { config, logger } = runtime;

  const server = app.listen(config.server.port, () => {
    logger.info('API listening', {
      port: config.server.port,
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
