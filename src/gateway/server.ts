import express from 'express';
import { loadGatewayConfig } from '../config.ts';
import { createFacilitator, supportsExact } from '../facilitator.ts';
import { JPYC_ADDRESS } from '../jpyc.ts';
import { VercelBlobLogStore } from '../logstore/blob.ts';
import { FileLogStore } from '../logstore/file.ts';
import type { LogStore } from '../logstore/types.ts';
import { PaymentLogWriter } from '../logstore/writer.ts';
import { loadRoutes } from '../routes.ts';
import { JinUpstreamBuyer } from '../upstream.ts';
import { createHandler } from './handler.ts';

const cfg = loadGatewayConfig();
const routes = loadRoutes();

const store: LogStore = cfg.logSink === 'blob' ? new VercelBlobLogStore({ token: cfg.blobReadWriteToken! }) : new FileLogStore(cfg.logDir);
const log = new PaymentLogWriter(store);

const facilitator = createFacilitator({
  url: cfg.facilitatorUrl,
  kind: cfg.facilitatorKind,
  cdpApiKeyId: cfg.cdpApiKeyId,
  cdpApiKeySecret: cfg.cdpApiKeySecret,
});

// 起動時に /supported を確かめる。exact + 対象ネットワークが無ければ支払いを受けても settle できないので起動しない
try {
  if (!(await supportsExact(facilitator, cfg.network))) {
    throw new Error(`facilitator ${cfg.facilitatorUrl} does not list exact on ${cfg.network} in /supported`);
  }
} catch (e) {
  if (process.env.SKIP_FACILITATOR_CHECK !== 'true') throw e;
  console.warn(`[startup] facilitator check skipped: ${(e as Error).message}`);
}

const upstream = await JinUpstreamBuyer.create({ svmPrivateKey: cfg.upstreamSolanaPrivateKey });
const handle = createHandler({
  routes,
  network: cfg.network,
  payTo: cfg.payTo,
  publicBaseUrl: cfg.publicBaseUrl,
  upstreamBaseUrl: cfg.upstreamJinBaseUrl,
  facilitator,
  facilitatorKind: cfg.facilitatorKind,
  upstream,
  log,
});

const app = express();
app.disable('x-powered-by');

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    network: cfg.network,
    asset: JPYC_ADDRESS,
    payTo: cfg.payTo,
    facilitator: { url: cfg.facilitatorUrl, kind: cfg.facilitatorKind },
    upstream: { base: cfg.upstreamJinBaseUrl, solanaWallet: upstream.address },
    logSink: cfg.logSink,
    logWriteFailures: log.failures,
    routes: routes.map((r) => ({ path: r.path, priceJpyc: r.priceJpyc, upstreamCostUsd: r.upstreamCostUsd })),
  });
});

app.use(async (req, res) => {
  try {
    const q = req.originalUrl.indexOf('?');
    const out = await handle({
      method: req.method,
      path: req.path,
      search: q >= 0 ? req.originalUrl.slice(q) : '',
      header: (n) => req.get(n) ?? undefined,
    });
    res.status(out.status);
    for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
    // ブラウザ等から PAYMENT-RESPONSE を読めるようにする
    res.setHeader('access-control-expose-headers', 'PAYMENT-REQUIRED, PAYMENT-RESPONSE');
    res.send(typeof out.body === 'string' ? out.body : Buffer.from(out.body));
  } catch (e) {
    console.error('[gateway] unhandled', e);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  }
});

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
