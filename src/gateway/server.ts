import { supportsExact } from '../facilitator.ts';
import { createGatewayApp } from './app.ts';

// ゲートウェイの起動（npm run gateway）
const { app, log, facilitator, cfg } = await createGatewayApp();

// 起動時に /supported を確かめる。exact + 対象ネットワークが無ければ支払いを受けても settle できないので起動しない
try {
  if (!(await supportsExact(facilitator, cfg.network))) {
    throw new Error(`facilitator ${cfg.facilitatorUrl} does not list exact on ${cfg.network} in /supported`);
  }
} catch (e) {
  if (process.env.SKIP_FACILITATOR_CHECK !== 'true') throw e;
  console.warn(`[startup] facilitator check skipped: ${(e as Error).message}`);
}

const server = app.listen(cfg.port, () => {
  console.log(`[gateway] listening on :${cfg.port} network=${cfg.network} facilitator=${cfg.facilitatorKind} payTo=${cfg.payTo}`);
});

const shutdown = async () => {
  server.close();
  await log.flush();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
