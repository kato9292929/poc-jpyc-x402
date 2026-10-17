import express from 'express';
import { loadGatewayConfig, type GatewayConfig } from '../config.ts';
import { createFacilitator, supportsExact } from '../facilitator.ts';
import { JPYC_ADDRESS } from '../jpyc.ts';
import { VercelBlobLogStore } from '../logstore/blob.ts';
import { FileLogStore } from '../logstore/file.ts';
import type { LogStore } from '../logstore/types.ts';
import { PaymentLogWriter } from '../logstore/writer.ts';
import { loadRoutes } from '../routes.ts';
import { JinUpstreamBuyer } from '../upstream.ts';
import { createHandler } from './handler.ts';

/**
 * ゲートウェイの express アプリ。ローカル（server.ts）と Vercel（vercel/gateway/api/index.ts）の両方から使う。
 * サーバーレスでは 1 リクエストごとにプロセスが終わる可能性があるので、応答の前にログの書き込みを待つ。
 */
export async function createGatewayApp(cfg: GatewayConfig = loadGatewayConfig(), opts: { flushLogBeforeResponse?: boolean } = {}) {
  const routes = loadRoutes();
  const store: LogStore = cfg.logSink === 'blob' ? new VercelBlobLogStore({ token: cfg.blobReadWriteToken! }) : new FileLogStore(cfg.logDir);
  const log = new PaymentLogWriter(store);
  const facilitator = createFacilitator({
    url: cfg.facilitatorUrl,
    kind: cfg.facilitatorKind,
    cdpApiKeyId: cfg.cdpApiKeyId,
    cdpApiKeySecret: cfg.cdpApiKeySecret,
    bearerToken: cfg.facilitatorAuthToken,
  });
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
  app.set('trust proxy', true);

  app.get('/healthz', async (req, res) => {
    let supported: boolean | string = 'not_checked';
    if (req.query.check === 'facilitator') {
      try {
        supported = await supportsExact(facilitator, cfg.network);
      } catch (e) {
        supported = `error: ${(e as Error).message}`;
      }
    }
    res.json({
      ok: true,
      network: cfg.network,
      asset: JPYC_ADDRESS,
      payTo: cfg.payTo,
      facilitator: { url: cfg.facilitatorUrl, kind: cfg.facilitatorKind, cdpKeys: !!(cfg.cdpApiKeyId && cfg.cdpApiKeySecret), exactSupported: supported },
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
      if (opts.flushLogBeforeResponse) await log.flush();
      res.status(out.status);
      for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
      res.setHeader('access-control-expose-headers', 'PAYMENT-REQUIRED, PAYMENT-RESPONSE');
      res.send(typeof out.body === 'string' ? out.body : Buffer.from(out.body));
    } catch (e) {
      console.error('[gateway] unhandled', e);
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
    }
  });

  return { app, log, facilitator, cfg };
}
