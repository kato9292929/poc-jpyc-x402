import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader, type FacilitatorClient } from '@x402/core/http';
import type { PaymentPayload, SettleResponse } from '@x402/core/types';
import { jstIso, type FacilitatorKind, type PaymentLogEntry, type PaymentStatus } from '../log.ts';
import type { PaymentLogWriter } from '../logstore/writer.ts';
import { NonceCache } from '../nonce.ts';
import { buildPaymentRequired, buildRequirements, precheckPayment } from '../payment.ts';
import { usdToUsdcAtomic, type Route } from '../routes.ts';
import type { UpstreamBuyer } from '../upstream.ts';
import type { JpycNetwork } from '../jpyc.ts';

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

export interface HandlerDeps {
  routes: Route[];
  network: JpycNetwork;
  payTo: string;
  publicBaseUrl: string;
  upstreamBaseUrl: string;
  facilitator: FacilitatorClient;
  facilitatorKind: FacilitatorKind;
  upstream: UpstreamBuyer;
  log: PaymentLogWriter;
  nonces?: NonceCache;
  now?: () => Date;
}

const json = (status: number, obj: unknown, headers: Record<string, string> = {}): GatewayResponse => ({
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  body: JSON.stringify(obj),
});

/**
 * 1 リクエストの処理（指示書 §1 の構成図）。
 * 402 → 再送（PAYMENT-SIGNATURE）→ ゲートウェイ側の事前検査 → facilitator /verify → /settle → 上流（JIN）を x402 で購入 → 返す。
 * 支払いを伴ったリクエストは、結果によらず必ず決済ログを 1 行書く。
 */
export function createHandler(deps: HandlerDeps) {
  const nonces = deps.nonces ?? new NonceCache();
  const now = deps.now ?? (() => new Date());

  return async function handle(req: GatewayRequest): Promise<GatewayResponse> {
    const route = deps.routes.find((r) => r.path === req.path);
    if (!route) return json(404, { error: 'not_found', routes: deps.routes.map((r) => r.path) });
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' }, { allow: 'GET' });

    const upstreamUrl = deps.upstreamBaseUrl + route.upstreamPath + req.search;
    const upstreamCostAtomic = usdToUsdcAtomic(route.upstreamCostUsd);

    // 無料のエンドポイント：402 を返さず上流をそのまま返す（決済ではないのでログも書かない）
    if (route.priceJpyc === '0') {
      const up = await deps.upstream.buy(upstreamUrl, 0n);
      if (up.status < 200 || up.status >= 300) return json(502, { error: 'upstream_failed', detail: up.error });
      return { status: up.status, headers: { 'content-type': up.contentType ?? 'application/json' }, body: up.body };
    }

    const requirements = buildRequirements({ network: deps.network, payTo: deps.payTo, priceJpyc: route.priceJpyc });
    const resourceUrl = deps.publicBaseUrl + route.path;
    const paymentRequired = (error?: string) => {
      const pr = buildPaymentRequired({ url: resourceUrl, description: route.description, requirements, error });
      return json(402, pr, { 'payment-required': encodePaymentRequiredHeader(pr) });
    };

    const sig = req.header('payment-signature');
    if (!sig) return paymentRequired();

    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(sig);
    } catch {
      return paymentRequired('invalid_payment_signature_header');
    }

    const base = {
      endpoint: route.path,
      price_jpyc: Number(route.priceJpyc),
      pay_to: deps.payTo,
      network: deps.network,
      facilitator: deps.facilitatorKind,
      upstream_cost_usd: Number(route.upstreamCostUsd),
    };
    const write = (fields: { status: PaymentStatus; payer: string; settle_tx?: string; settle_ms?: number; upstream_tx?: string; error?: string }) => {
      const entry: PaymentLogEntry = {
        ts: jstIso(now()),
        ...base,
        payer: fields.payer,
        settle_tx: fields.settle_tx ?? 'none',
        settle_ms: fields.settle_ms ?? 0,
        upstream_tx: fields.upstream_tx ?? 'none',
        status: fields.status,
        error: fields.error,
      };
      // 上流が失敗したときは JPYC を受領済み（手動返金の対象）。原価は払っていないので 0 にする
      if (fields.status !== 'ok' && !fields.upstream_tx) entry.upstream_cost_usd = 0;
      deps.log.write(entry);
    };

    // ゲートウェイ側の事前検査（金額の完全一致・nonce の再送など）。通らなければ facilitator に投げない
    const pre = precheckPayment(payload, requirements, nonces, Math.floor(now().getTime() / 1000));
    if (!pre.ok) {
      write({ status: 'verify_failed', payer: pre.payer, error: `precheck: ${pre.reason}` });
      return paymentRequired(pre.reason);
    }

    const t0 = Date.now();
    try {
      const v = await deps.facilitator.verify(payload, requirements);
      if (!v.isValid) {
        const reason = v.invalidReason ?? 'invalid';
        write({ status: 'verify_failed', payer: pre.payer, error: `verify: ${reason}${v.invalidMessage ? ` (${v.invalidMessage})` : ''}` });
        return paymentRequired(reason);
      }
      if (v.payer && v.payer.toLowerCase() !== pre.payer.toLowerCase()) {
        write({ status: 'verify_failed', payer: pre.payer, error: `verify: payer mismatch ${v.payer}` });
        return paymentRequired('payer_mismatch');
      }
    } catch (e) {
      write({ status: 'verify_failed', payer: pre.payer, error: `verify error: ${(e as Error).message}` });
      return json(502, { error: 'facilitator_verify_error' });
    }

    let settled: SettleResponse;
    try {
      settled = await deps.facilitator.settle(payload, requirements);
    } catch (e) {
      // タイムアウトは結果不明（facilitator 側で settle が完了している可能性がある）。tx は Polygonscan で確認する
      write({ status: 'settle_failed', payer: pre.payer, settle_ms: Date.now() - t0, error: `settle error: ${(e as Error).message}` });
      return json(502, { error: 'facilitator_settle_error' });
    }
    const settleMs = Date.now() - t0;
    const paymentResponse = { 'payment-response': encodePaymentResponseHeader(settled) };
    if (!settled.success || !settled.transaction) {
      write({
        status: 'settle_failed',
        payer: pre.payer,
        settle_tx: settled.transaction || 'none',
        settle_ms: settleMs,
        error: `settle: ${settled.errorReason ?? 'failed'}${settled.errorMessage ? ` (${settled.errorMessage})` : ''}`,
      });
      const pr = buildPaymentRequired({ url: resourceUrl, description: route.description, requirements, error: settled.errorReason ?? 'settle_failed' });
      return json(402, pr, { 'payment-required': encodePaymentRequiredHeader(pr), ...paymentResponse });
    }

    // JPYC は受領済み。ここから上流（JIN）を購入する
    const up = await deps.upstream.buy(upstreamUrl, upstreamCostAtomic);
    // 2xx でデータが返れば成功（PAYMENT-RESPONSE が読めず tx が不明な場合も、買い手にはデータを返す）
    const upOk = up.status >= 200 && up.status < 300;
    if (!upOk) {
      write({
        status: 'upstream_failed',
        payer: pre.payer,
        settle_tx: settled.transaction,
        settle_ms: settleMs,
        upstream_tx: up.tx,
        error: up.error ?? `upstream ${up.status}`,
      });
      // 返金はこの実証では自動化しない（ログの status=upstream_failed を数えて手動で返す）
      return json(
        502,
        { error: 'upstream_failed', settle_tx: settled.transaction, refund: 'manual', detail: up.error },
        paymentResponse,
      );
    }

    write({ status: 'ok', payer: pre.payer, settle_tx: settled.transaction, settle_ms: settleMs, upstream_tx: up.tx ?? 'unknown' });
    return {
      status: 200,
      headers: { 'content-type': up.contentType ?? 'application/json', 'cache-control': 'no-store', ...paymentResponse },
      body: up.body,
    };
  };
}
