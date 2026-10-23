import { test } from 'node:test';
import assert from 'node:assert/strict';
import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, decodePaymentSignatureHeader, encodePaymentSignatureHeader, type FacilitatorClient } from '@x402/core/http';
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { decodePaymentResponseHeader, wrapFetchWithPayment } from '@x402/fetch';
import { getAddress, verifyTypedData } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createHandler, type GatewayResponse } from '../src/gateway/handler.ts';
import { JPYC_ADDRESS, JPYC_EIP712, chainIdOf, jpycToAtomic } from '../src/jpyc.ts';
import { MemoryLogStore } from '../src/logstore/memory.ts';
import { parseLines } from '../src/logstore/types.ts';
import { PaymentLogWriter } from '../src/logstore/writer.ts';
import { loadRoutes } from '../src/routes.ts';
import type { UpstreamBuyer, UpstreamResult } from '../src/upstream.ts';

const PAY_TO = getAddress('0x2222222222222222222222222222222222222222');
const SETTLE_TX = '0x' + 'ab'.repeat(32);

/** 署名を本当に検証する偽の facilitator（JPYC の domain で ecrecover できるか） */
class FakeFacilitator implements FacilitatorClient {
  verifyCalls = 0;
  settleCalls = 0;
  settleResult: Partial<SettleResponse> = {};
  async verify(p: PaymentPayload, r: PaymentRequirements): Promise<VerifyResponse> {
    this.verifyCalls++;
    const { authorization: a, signature } = p.payload as any;
    const ok = await verifyTypedData({
      address: a.from,
      domain: { name: JPYC_EIP712.name, version: JPYC_EIP712.version, chainId: chainIdOf(r.network as any), verifyingContract: r.asset as `0x${string}` },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) },
      signature,
    });
    return ok ? { isValid: true, payer: a.from } : { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' };
  }
  async settle(p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> {
    this.settleCalls++;
    return { success: true, transaction: SETTLE_TX, network: r.network as any, payer: (p.payload as any).authorization.from, ...this.settleResult };
  }
  async getSupported(): Promise<SupportedResponse> {
    return { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:137' }], extensions: [], signers: {} } as any;
  }
}

class FakeUpstream implements UpstreamBuyer {
  calls: { url: string; cost: bigint }[] = [];
  result: Partial<UpstreamResult> = {};
  async buy(url: string, cost: bigint): Promise<UpstreamResult> {
    this.calls.push({ url, cost });
    return {
      status: 200,
      body: new TextEncoder().encode(JSON.stringify({ source: 'jin', url })),
      contentType: 'application/json',
      paid: cost > 0n,
      tx: cost > 0n ? '5SolanaSig' : undefined,
      ...this.result,
    };
  }
}

function setup() {
  const facilitator = new FakeFacilitator();
  const upstream = new FakeUpstream();
  const store = new MemoryLogStore();
  const log = new PaymentLogWriter(store, () => undefined);
  const handle = createHandler({
    routes: loadRoutes({}),
    network: 'eip155:137',
    payTo: PAY_TO,
    publicBaseUrl: 'https://gw.example',
    upstreamBaseUrl: 'https://jin.x402jp.com',
    facilitator,
    facilitatorKind: 'cdp',
    upstream,
    log,
  });
  // handler を fetch として見せる（@x402/fetch からそのまま叩けるように）
  const gwFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    const out: GatewayResponse = await handle({ method: req.method, path: u.pathname, search: u.search, header: (n) => req.headers.get(n) ?? undefined });
    return new Response(out.body as BodyInit, { status: out.status, headers: out.headers });
  };
  const rows = async () => {
    await log.flush();
    return [...store.files.values()].flatMap((t) => parseLines(t));
  };
  return { facilitator, upstream, gwFetch, rows, handle };
}

function buyer(gwFetch: typeof fetch) {
  const account = privateKeyToAccount(generatePrivateKey());
  const client = new x402Client();
  client.register('eip155:137', new ExactEvmScheme(account));
  client.setSpendControls({ maxAmountPerPayment: false, allowedAssets: [{ network: 'eip155:137', asset: JPYC_ADDRESS, maxAmountPerPayment: jpycToAtomic('20').toString() }] });
  return { account, client, pay: wrapFetchWithPayment(gwFetch, client) };
}

test('402 の accepts に Polygon・JPYC・金額（18桁）・payTo・domain が入る', async () => {
  const { gwFetch } = setup();
  const res = await gwFetch('https://gw.example/jin/series');
  assert.equal(res.status, 402);
  const pr = decodePaymentRequiredHeader(res.headers.get('payment-required')!);
  assert.equal(pr.x402Version, 2);
  assert.equal(pr.accepts.length, 1);
  const a = pr.accepts[0];
  assert.equal(a.scheme, 'exact');
  assert.equal(a.network, 'eip155:137');
  assert.equal(a.asset, JPYC_ADDRESS);
  assert.equal(a.amount, '2000000000000000000');
  assert.equal(a.payTo, PAY_TO);
  assert.ok(a.maxTimeoutSeconds <= 300);
  assert.deepEqual({ name: a.extra.name, version: a.extra.version }, { name: 'JPY Coin', version: '1' });
  assert.equal(pr.resource.url, 'https://gw.example/jin/series');
  assert.deepEqual(await res.json(), pr);
});

test('@x402/fetch の買い手が JPYC で 1 件購入できる（verify → settle → 上流 → 200、ログ 1 行）', async () => {
  const { gwFetch, rows, upstream, facilitator } = setup();
  const { pay, account } = buyer(gwFetch as typeof fetch);
  const res = await pay('https://gw.example/jin/series?days=7');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).url, 'https://jin.x402jp.com/api/jin/series?days=7');
  assert.equal(decodePaymentResponseHeader(res.headers.get('payment-response')!).transaction, SETTLE_TX);
  assert.equal(facilitator.verifyCalls, 1);
  assert.equal(facilitator.settleCalls, 1);
  assert.deepEqual(upstream.calls, [{ url: 'https://jin.x402jp.com/api/jin/series?days=7', cost: 10_000n }]);
  const r = await rows();
  assert.equal(r.length, 1);
  assert.equal(r[0].status, 'ok');
  assert.equal(r[0].endpoint, '/jin/series');
  assert.equal(r[0].price_jpyc, 2);
  assert.equal(r[0].payer, account.address);
  assert.equal(r[0].pay_to, PAY_TO);
  assert.equal(r[0].network, 'eip155:137');
  assert.equal(r[0].facilitator, 'cdp');
  assert.equal(r[0].settle_tx, SETTLE_TX);
  assert.equal(r[0].upstream_cost_usd, 0.01);
  assert.equal(r[0].upstream_tx, '5SolanaSig');
  assert.match(r[0].ts, /\+09:00$/);
  assert.equal(typeof r[0].settle_ms, 'number');
});

test('署名の nonce は 32 バイトのランダム値、validBefore は 5 分以内', async () => {
  const { gwFetch } = setup();
  const { client } = buyer(gwFetch as typeof fetch);
  const pr = decodePaymentRequiredHeader((await gwFetch('https://gw.example/jin/movers')).headers.get('payment-required')!);
  const p1 = await client.createPaymentPayload(pr);
  const p2 = await client.createPaymentPayload(pr);
  const a1 = (p1.payload as any).authorization;
  assert.match(a1.nonce, /^0x[0-9a-f]{64}$/);
  assert.notEqual(a1.nonce, (p2.payload as any).authorization.nonce);
  assert.ok(Number(a1.validBefore) - Math.floor(Date.now() / 1000) <= 300);
  assert.equal(a1.value, '3000000000000000000');
});

test('同じ nonce の再送は facilitator に投げる前に弾く', async () => {
  const { gwFetch, facilitator, rows } = setup();
  const { client } = buyer(gwFetch as typeof fetch);
  const pr = decodePaymentRequiredHeader((await gwFetch('https://gw.example/jin/series')).headers.get('payment-required')!);
  const header = encodePaymentSignatureHeader(await client.createPaymentPayload(pr));
  const first = await gwFetch('https://gw.example/jin/series', { headers: { 'PAYMENT-SIGNATURE': header } });
  assert.equal(first.status, 200);
  const again = await gwFetch('https://gw.example/jin/series', { headers: { 'PAYMENT-SIGNATURE': header } });
  assert.equal(again.status, 402);
  assert.equal((await again.json()).error, 'nonce_replayed');
  assert.equal(facilitator.verifyCalls, 1);
  const r = await rows();
  assert.deepEqual(r.map((x) => x.status), ['ok', 'verify_failed']);
  assert.match(r[1].error, /nonce_replayed/);
});

test('value が 402 の提示額と違えば verify に進まない', async () => {
  const { gwFetch, facilitator, rows } = setup();
  const { client } = buyer(gwFetch as typeof fetch);
  const pr = decodePaymentRequiredHeader((await gwFetch('https://gw.example/jin/series')).headers.get('payment-required')!);
  // 1 JPYC 分の要求に署名させ、2 JPYC のエンドポイントに出す
  const cheap = { ...pr, accepts: [{ ...pr.accepts[0], amount: jpycToAtomic('1').toString() }] };
  const p = await client.createPaymentPayload(cheap);
  const res = await gwFetch('https://gw.example/jin/series', { headers: { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(p) } });
  assert.equal(res.status, 402);
  assert.equal(facilitator.verifyCalls, 0);
  // accepted を書き換えて value だけ違うものも弾く
  const forged = { ...p, accepted: pr.accepts[0] };
  const res2 = await gwFetch('https://gw.example/jin/series', { headers: { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(forged) } });
  assert.equal((await res2.json()).error, 'authorization_value_mismatch');
  assert.equal(facilitator.verifyCalls, 0);
  assert.deepEqual((await rows()).map((x) => x.status), ['verify_failed', 'verify_failed']);
});

test('validBefore が 5 分より先なら弾く', async () => {
  const { gwFetch, facilitator } = setup();
  const { client } = buyer(gwFetch as typeof fetch);
  const pr = decodePaymentRequiredHeader((await gwFetch('https://gw.example/jin/series')).headers.get('payment-required')!);
  const long = { ...pr, accepts: [{ ...pr.accepts[0], maxTimeoutSeconds: 3600 }] };
  const p = await client.createPaymentPayload(long);
  const forged = { ...p, accepted: pr.accepts[0] };
  const res = await gwFetch('https://gw.example/jin/series', { headers: { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(forged) } });
  assert.equal((await res.json()).error, 'valid_before_too_far');
  assert.equal(facilitator.verifyCalls, 0);
});

test('署名が別の domain なら facilitator の verify で落ちる（verify_failed、settle しない）', async () => {
  const { gwFetch, facilitator, rows } = setup();
  const { client } = buyer(gwFetch as typeof fetch);
  const pr = decodePaymentRequiredHeader((await gwFetch('https://gw.example/jin/series')).headers.get('payment-required')!);
  const wrong = { ...pr, accepts: [{ ...pr.accepts[0], extra: { name: 'JPYC', version: '1' } }] };
  const p = await client.createPaymentPayload(wrong);
  const forged = { ...p, accepted: pr.accepts[0] };
  const res = await gwFetch('https://gw.example/jin/series', { headers: { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(forged) } });
  assert.equal(res.status, 402);
  assert.equal(facilitator.verifyCalls, 1);
  assert.equal(facilitator.settleCalls, 0);
  assert.equal((await rows())[0].status, 'verify_failed');
});

test('settle 失敗は settle_failed で記録し、上流は買わない', async () => {
  const { gwFetch, facilitator, upstream, rows } = setup();
  facilitator.settleResult = { success: false, transaction: '', errorReason: 'insufficient_funds' };
  const { pay } = buyer(gwFetch as typeof fetch);
  const res = await pay('https://gw.example/jin/series');
  assert.equal(res.status, 402);
  assert.equal(upstream.calls.length, 0);
  const r = await rows();
  assert.equal(r.at(-1).status, 'settle_failed');
  assert.equal(r.at(-1).settle_tx, 'none');
  assert.match(r.at(-1).error, /insufficient_funds/);
});

test('上流の購入に失敗したら upstream_failed で記録し、買い手には 502（JPYC は受領済み）', async () => {
  const { gwFetch, upstream, rows } = setup();
  upstream.result = { status: 402, body: new Uint8Array(), paid: false, tx: undefined, error: 'upstream requirement mismatch' };
  const { pay } = buyer(gwFetch as typeof fetch);
  const res = await pay('https://gw.example/jin/movers');
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error, 'upstream_failed');
  assert.equal(body.settle_tx, SETTLE_TX);
  assert.equal(body.refund, 'manual');
  const r = await rows();
  assert.equal(r.length, 1);
  assert.equal(r[0].status, 'upstream_failed');
  assert.equal(r[0].settle_tx, SETTLE_TX);
  assert.equal(r[0].price_jpyc, 3);
  assert.equal(r[0].upstream_tx, 'none');
  assert.equal(r[0].upstream_cost_usd, 0);
});

test('/jin/latest は 402 を返さず無料で上流を返す（決済ログは書かない）', async () => {
  const { gwFetch, upstream, rows } = setup();
  const res = await gwFetch('https://gw.example/jin/latest');
  assert.equal(res.status, 200);
  assert.deepEqual(upstream.calls, [{ url: 'https://jin.x402jp.com/api/jin/latest', cost: 0n }]);
  assert.equal((await rows()).length, 0);
});

test('壊れた PAYMENT-SIGNATURE ヘッダ・未知のパス', async () => {
  const { gwFetch, facilitator } = setup();
  const bad = await gwFetch('https://gw.example/jin/series', { headers: { 'PAYMENT-SIGNATURE': 'not-base64!!' } });
  assert.equal(bad.status, 402);
  assert.equal(facilitator.verifyCalls, 0);
  assert.equal((await gwFetch('https://gw.example/osd/catalysts')).status, 404);
  void decodePaymentSignatureHeader;
});
