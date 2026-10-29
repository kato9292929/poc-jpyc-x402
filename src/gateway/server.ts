import { supportsExact } from '../facilitator.ts';
import { createGatewayApp } from './app.ts';

// ゲートウェイの起動（npm run gateway）。Vercel では vercel/gateway/entry.ts から createGatewayApp を使う
const { app, log, facilitators, cfg } = await createGatewayApp();

// 起動時に、各チェーンの facilitator の /supported に exact があるかを確かめる。無ければ支払いを受けても settle できないので起動しない
for (const n of cfg.networks) {
  try {
    if (!(await supportsExact(facilitators[n.network]!.client, n.network))) {
      throw new Error(`facilitator for ${n.network} does not list exact in /supported`);
    }
  } catch (e) {
    if (process.env.SKIP_FACILITATOR_CHECK !== 'true') throw e;
    console.warn(`[startup] facilitator check skipped: ${(e as Error).message}`);
  }
}

const server = app.listen(cfg.port, () => {
  console.log(`[gateway] listening on :${cfg.port} chains=${cfg.networks.map((n) => `${n.network}(${n.facilitator})`).join(',')} payTo=${cfg.payTo}`);
});

const shutdown = async () => {
  server.close();
  await log.flush();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
