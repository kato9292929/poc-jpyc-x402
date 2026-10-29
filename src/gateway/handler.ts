import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader, type FacilitatorClient } from '@x402/core/http';
import type { PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { bazaarExtension } from '../discovery.ts';
import type { JpycNetwork } from '../jpyc.ts';
import { jstDay, jstIso, toLogLine, type FacilitatorKind, type PaymentLogEntry, type PaymentStatus } from '../log.ts';
import type { PaymentLogWriter } from '../logstore/writer.ts';
import { buildPaymentRequired, buildRequirements, precheckPayment } from '../payment.ts';
import { findRoute, usdToUsdcAtomic, type Route } from '../routes.ts';
import { MemorySharedStore, type SharedStore } from '../stores.ts';
import type { UpstreamBuyer } from '../upstream.ts';

export interface GatewayRequest {
  method: string;
  path: string;
  /** "?a=1" のようなクエリ文字列（無ければ空） */
  search: string;
  header(name: string): string | undefined;
}

export interface GatewayResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | string;
}

export interface NetworkFacilitator {
  client: FacilitatorClient;
  kind: FacilitatorKind;
}

export interface HandlerDeps {
  routes: Route[];
  /** 受け付けるチェーン（402 の accepts にこの順で並べる） */
  networks: JpycNetwork[];
  facilitators: Partial<Record<JpycNetwork, NetworkFacilitator>>;
  payTo: string;
  publicBaseUrl: string;
  upstreamBaseUrls: Record<Route['upstream'], string>;
  upstream: UpstreamBuyer;
  log: PaymentLogWriter;
  store?: SharedStore;
  /** 上流への支払いの日次上限（USDC atomic、JST の日ごと）。既定 2 USDC */
  upstreamDailyCapMicro?: bigint;
  /** settle に失敗した payer を受け付けない時間。既定 24 時間 */
  blockMs?: number;
  now?: () => Date;
}

const json = (status: number, obj: unknown, headers: Record<string, string> = {}): GatewayResponse => ({
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  body: JSON.stringify(obj),
});

/**
 * 1 リクエストの処理（指示書4 §1：払ったのに届かない取引をなくす順番）。
 *
 *   402 → 再送（PAYMENT-SIGNATURE）→ 事前検査（金額・期限・nonce・受付停止中の payer）
 *   → 1. verify（まだ settle しない）
 *   → 2. 上流（JIN / OSD）を x402 で仕入れる（日次上限の範囲で）
 *   → 3. 仕入れに成功したら JPYC を settle
 *   → 4. settle に成功したらデータを返す
 *
 * 仕入れに失敗したら settle しない（買い手の署名は使われずに期限切れになり、買い手は払わない）。
 * 仕入れ後に settle が失敗したら、データは返さず上流原価の損失として記録し、その payer を 24 時間受け付けない。
 * 支払いを伴ったリクエストは、結果によらず決済ログを 1 行書き、同じ内容を X-PAYMENT-LOG ヘッダで買い手にも返す。
 */
export function createHandler(deps: HandlerDeps) {
  const store = deps.store ?? new MemorySharedStore();
  const now = deps.now ?? (() => new Date());
  const capMicro = deps.upstreamDailyCapMicro ?? 2_000_000n;
  const blockMs = deps.blockMs ?? 24 * 3_600_000;

  return async function handle(req: GatewayRequest): Promise<GatewayResponse> {
    const found = findRoute(deps.routes, req.path);
    if (!found) return json(404, { error: 'not_found', routes: deps.routes.map((r) => r.path) });
    const { route, upstreamPath, params } = found;
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' }, { allow: 'GET' });

    const upstreamUrl = deps.upstreamBaseUrls[route.upstream] + upstreamPath + req.search;
    const upstreamCostAtomic = usdToUsdcAtomic(route.upstreamCostUsd);

    // 無料のエンドポイント：402 を返さず上流をそのまま返す（決済ではないのでログも書かない）
    if (route.priceJpyc === '0') {
      const up = await deps.upstream.buy(upstreamUrl, 0n);
      if (up.status < 200 || up.status >= 300) return json(502, { error: 'upstream_failed', detail: up.error });
      return { status: up.status, headers: { 'content-type': up.contentType ?? 'application/json' }, body: up.body };
    }

    const requirements = deps.networks.map((network) => buildRequirements({ network, payTo: deps.payTo, priceJpyc: route.priceJpyc }));
    const resourceUrl = deps.publicBaseUrl + req.path;
    const paymentRequired = (error?: string, extra: Record<string, string> = {}) => {
      const pr = buildPaymentRequired({ url: resourceUrl, description: route.description, requirements, error, extensions: bazaarExtension(route, params) });
      return json(402, pr, { 'payment-required': encodePaymentRequiredHeader(pr), ...extra });
    };

    const sig = req.header('payment-signature');
    if (!sig) return paymentRequired();

    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(sig);
    } catch {
      return paymentRequired('invalid_payment_signature_header');
    }

    const chosen: PaymentRequirements | undefined = requirements.find((r) => r.network === payload?.accepted?.network);
    const network = (chosen?.network ?? payload?.accepted?.network ?? 'unknown') as JpycNetwork;
    const fac = chosen ? deps.facilitators[network] : undefined;
    const t0 = Date.now();
    let upstreamMs = 0;
    // 段階ごとの所要時間（Server-Timing ヘッダで返す。遅い段階を外から見つけるため）
    const marks: string[] = [];
    const timed = async <T>(name: string, p: Promise<T>): Promise<T> => {
      const s = Date.now();
      try {
        return await p;
      } finally {
        marks.push(`${name};dur=${Date.now() - s}`);
      }
    };

    const write = (fields: { status: PaymentStatus; payer: string; settle_tx?: string; upstream_tx?: string; upstream_paid?: boolean; error?: string; timed?: boolean }): Record<string, string> => {
      const entry: PaymentLogEntry = {
        ts: jstIso(now()),
        endpoint: route.path,
        price_jpyc: Number(route.priceJpyc),
        payer: fields.payer,
        pay_to: deps.payTo,
        network,
        facilitator: fac?.kind ?? 'cdp',
        settle_tx: fields.settle_tx ?? 'none',
        settle_ms: fields.timed ? Date.now() - t0 : 0,
        // 上流に払った（払った可能性がある）ときだけ原価を載せる
        upstream_cost_usd: fields.upstream_paid ? Number(route.upstreamCostUsd) : 0,
        upstream_tx: fields.upstream_tx ?? 'none',
        status: fields.status,
        error: fields.error,
        flow: 'settle_last',
      };
      deps.log.write(entry);
      let header = '';
      try {
        header = Buffer.from(toLogLine(entry)).toString('base64');
      } catch {
        header = '';
      }
      const out: Record<string, string> = {};
      if (header) out['x-payment-log'] = header;
      if (marks.length) out['server-timing'] = marks.join(', ');
      return out;
    };

    if (!chosen || !fac) {
      const h = write({ status: 'verify_failed', payer: 'unknown', error: `precheck: network_not_accepted (${network})` });
      return paymentRequired('network_not_accepted', h);
    }

    // 事前検査（金額の完全一致・期限・nonce の形）。通らなければ facilitator に投げない
    const pre = precheckPayment(payload, chosen, undefined, Math.floor(now().getTime() / 1000));
    if (!pre.ok) {
      const h = write({ status: 'verify_failed', payer: pre.payer, error: `precheck: ${pre.reason}` });
      return paymentRequired(pre.reason, h);
    }
    if (await timed('blocked', store.isBlocked(pre.payer, now().getTime()))) {
      const h = write({ status: 'verify_failed', payer: pre.payer, error: 'precheck: payer_blocked (settle failed within 24h)' });
      return paymentRequired('payer_blocked', h);
    }
    // 同じ署名の再送は facilitator に投げる前に弾く（関数の間で共有するストアで確かめる）
    if (!(await timed('nonce', store.claimNonce(`${network}:${pre.payer}:${pre.authorization.nonce}`, pre.validBefore * 1000 + 10 * 60_000)))) {
      const h = write({ status: 'verify_failed', payer: pre.payer, error: 'precheck: nonce_replayed' });
      return paymentRequired('nonce_replayed', h);
    }

    // 1. verify（まだ settle しない）
    try {
      const v = await timed('verify', fac.client.verify(payload, chosen));
      if (!v.isValid) {
        const reason = v.invalidReason ?? 'invalid';
        const h = write({ status: 'verify_failed', payer: pre.payer, error: `verify: ${reason}${v.invalidMessage ? ` (${v.invalidMessage})` : ''}` });
        return paymentRequired(reason, h);
      }
      if (v.payer && v.payer.toLowerCase() !== pre.payer.toLowerCase()) {
        const h = write({ status: 'verify_failed', payer: pre.payer, error: `verify: payer mismatch ${v.payer}` });
        return paymentRequired('payer_mismatch', h);
      }
    } catch (e) {
      const h = write({ status: 'verify_failed', payer: pre.payer, error: `verify error: ${(e as Error).message}` });
      return json(502, { error: 'facilitator_verify_error', charged: false }, h);
    }

    // 2. 上流を仕入れる（上流への支払いの日次上限の範囲で）
    const day = jstDay(now());
    if (!(await timed('spend', store.reserveSpend(day, upstreamCostAtomic, capMicro)))) {
      const h = write({ status: 'upstream_failed', payer: pre.payer, error: `daily upstream cap reached (${Number(capMicro) / 1e6} USDC)` });
      return json(503, { error: 'daily_capacity_reached', charged: false }, { 'retry-after': '3600', ...h });
    }
    const u0 = Date.now();
    const up = await timed('upstream', deps.upstream.buy(upstreamUrl, upstreamCostAtomic));
    upstreamMs = Date.now() - u0;
    if (!up.paid) await store.releaseSpend(day, upstreamCostAtomic).catch(() => undefined);
    if (up.status < 200 || up.status >= 300) {
      // 仕入れに失敗：settle しない。買い手の署名は使われずに期限切れになる
      const h = write({
        status: 'upstream_failed',
        payer: pre.payer,
        upstream_tx: up.tx,
        upstream_paid: up.paid && !!up.tx,
        error: up.error ?? `upstream ${up.status}`,
        timed: true,
      });
      return json(up.status === 404 ? 404 : 502, { error: up.status === 404 ? 'not_found_upstream' : 'upstream_failed', charged: false, detail: up.error }, h);
    }
    if (!up.paid) {
      // 上流が請求しなかった（OSD の未調査銘柄など）。買い手からも受け取らずに返す
      const h = write({ status: 'free', payer: pre.payer, error: 'upstream did not charge; served free', timed: true });
      return { status: 200, headers: { 'content-type': up.contentType ?? 'application/json', 'cache-control': 'no-store', 'x-charged': 'false', ...h }, body: up.body };
    }

    // 3. 仕入れに成功したので JPYC を settle
    let settled: SettleResponse | undefined;
    let settleError: string | undefined;
    try {
      settled = await timed('settle', fac.client.settle(payload, chosen));
      if (!settled.success || !settled.transaction) {
        settleError = `settle: ${settled.errorReason ?? 'failed'}${settled.errorMessage ? ` (${settled.errorMessage})` : ''}`;
      }
    } catch (e) {
      settleError = `settle error: ${(e as Error).message}`;
    }
    if (settleError) {
      // 上流原価の損失。データは返さず、この payer を 24 時間受け付けない
      await store.block(pre.payer, now().getTime() + blockMs, settleError).catch(() => undefined);
      const h = write({
        status: 'settle_failed',
        payer: pre.payer,
        settle_tx: settled?.transaction || 'none',
        upstream_tx: up.tx ?? 'unknown',
        upstream_paid: true,
        error: `${settleError} (upstream ${upstreamMs}ms)`,
        timed: true,
      });
      const pr = buildPaymentRequired({ url: resourceUrl, description: route.description, requirements, error: settled?.errorReason ?? 'settle_failed' });
      return json(402, pr, { 'payment-required': encodePaymentRequiredHeader(pr), ...(settled ? { 'payment-response': encodePaymentResponseHeader(settled) } : {}), ...h });
    }

    // 4. settle に成功したのでデータを返す
    const h = write({ status: 'ok', payer: pre.payer, settle_tx: settled!.transaction, upstream_tx: up.tx ?? 'unknown', upstream_paid: true, timed: true });
    return {
      status: 200,
      headers: {
        'content-type': up.contentType ?? 'application/json',
        'cache-control': 'no-store',
        'payment-response': encodePaymentResponseHeader(settled!),
        ...h,
      },
      body: up.body,
    };
  };
}
