import express from 'express';
import { loadGatewayConfig, type GatewayConfig } from '../config.ts';
import { openApiDocument } from '../discovery.ts';
import { createNetworkFacilitators, supportsExact } from '../facilitator.ts';
import { JPYC_ADDRESS } from '../jpyc.ts';
import { jstDay } from '../log.ts';
import { FileLogStore } from '../logstore/file.ts';
import type { LogStore } from '../logstore/types.ts';
import { PaymentLogWriter } from '../logstore/writer.ts';
import { NETWORK_SPECS } from '../networks.ts';
import { loadRoutes } from '../routes.ts';
import { MemorySharedStore, type SharedStore } from '../stores.ts';
import { JinUpstreamBuyer } from '../upstream.ts';
import { createHandler } from './handler.ts';

/**
 * ゲートウェイの express アプリ。ローカル（server.ts）と Vercel（vercel/gateway/entry.ts）の両方から使う。
 * flushLogBeforeResponse：プロセスが応答直後に止まる環境（Vercel の関数）向けに、応答の前にログの書き込みを待つ。
 */
export async function createGatewayApp(cfg: GatewayConfig = loadGatewayConfig(), opts: { flushLogBeforeResponse?: boolean } = {}) {
  const routes = loadRoutes();
  // 本番はゲートウェイで保存しない（X-PAYMENT-LOG で買い手に返す。Actions の買い手ログが正）
  const logStore: LogStore = cfg.logSink === 'file' ? new FileLogStore(cfg.logDir) : { append: async () => undefined, read: async () => null, days: async () => [] } as unknown as LogStore;
  const log = new PaymentLogWriter(logStore);
  // nonce は関数インスタンス内のメモリで弾く。インスタンスをまたぐ二重の仕入れは上流の日次上限（2 USDC）で抑える
  const store: SharedStore = new MemorySharedStore();
  const facilitators = await createNetworkFacilitators(cfg);
  const upstream = await JinUpstreamBuyer.create({ svmPrivateKey: cfg.upstreamSolanaPrivateKey });
  const networks = cfg.networks.map((n) => n.network);
  const handle = createHandler({
    routes,
    networks,
    facilitators,
    payTo: cfg.payTo,
    publicBaseUrl: cfg.publicBaseUrl,
    upstreamBaseUrls: { jin: cfg.upstreamJinBaseUrl, osd: cfg.upstreamOsdBaseUrl },
    upstream,
    log,
    store,
    upstreamDailyCapMicro: cfg.upstreamDailyCapMicro,
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.get('/healthz', async (req, res) => {
    const check = req.query.check === 'facilitator';
    const chains = await Promise.all(
      cfg.networks.map(async (n) => {
        const f = facilitators[n.network]!;
        let supported: boolean | string = 'not_checked';
        if (check) {
          try {
            supported = await supportsExact(f.client, n.network);
          } catch (e) {
            supported = `error: ${(e as Error).message}`;
          }
        }
        return { network: n.network, label: NETWORK_SPECS[n.network].label, facilitator: f.kind, relayer: f.relayer, exactSupported: supported };
      }),
    );
    let spentToday: string | undefined;
    try {
      spentToday = (Number(await store.spent(jstDay())) / 1e6).toFixed(6);
    } catch {
      spentToday = undefined;
    }
    res.set('cache-control', 'no-store').json({
      ok: true,
      asset: JPYC_ADDRESS,
      payTo: cfg.payTo,
      chains,
      upstream: { jin: cfg.upstreamJinBaseUrl, osd: cfg.upstreamOsdBaseUrl, solanaWallet: upstream.address, spentTodayUsdc: spentToday, dailyCapUsdc: (Number(cfg.upstreamDailyCapMicro) / 1e6).toFixed(2) },
      flow: 'verify → upstream → settle',
      logSink: cfg.logSink,
      stateStore: 'memory',
      logWriteFailures: log.failures,
      ...(log.lastError ? { lastLogWriteError: log.lastError } : {}),
      routes: routes.map((r) => ({ path: r.path, priceJpyc: r.priceJpyc, upstreamCostUsd: r.upstreamCostUsd })),
    });
  });

  app.get('/openapi.json', (_req, res) => {
    res.set('cache-control', 'public, max-age=300').json(openApiDocument({ publicBaseUrl: cfg.publicBaseUrl, routes, networks, jpycUsdRate: cfg.jpycUsdRate }));
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
      if (opts.flushLogBeforeResponse) {
        const s = Date.now();
        await log.flush();
        if (out.headers['server-timing']) out.headers['server-timing'] += `, log;dur=${Date.now() - s}`;
      }
      res.status(out.status);
      for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-expose-headers', 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-LOG, X-CHARGED, Server-Timing');
      res.send(typeof out.body === 'string' ? out.body : Buffer.from(out.body));
    } catch (e) {
      console.error('[gateway] unhandled', e);
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
    }
  });

  return { app, log, facilitators, cfg };
}
