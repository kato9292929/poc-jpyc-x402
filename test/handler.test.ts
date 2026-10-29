import { test } from 'node:test';
import assert from 'node:assert/strict';
import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader, type FacilitatorClient } from '@x402/core/http';
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { decodePaymentResponseHeader, wrapFetchWithPayment } from '@x402/fetch';
import { getAddress, verifyTypedData } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createHandler, type GatewayResponse } from '../src/gateway/handler.ts';
import { AVALANCHE, JPYC_ADDRESS, JPYC_EIP712, KAIA, POLYGON_MAINNET, chainIdOf, jpycToAtomic, type JpycNetwork } from '../src/jpyc.ts';
import { MemoryLogStore } from '../src/logstore/memory.ts';
import { parseLines } from '../src/logstore/types.ts';
import { PaymentLogWriter } from '../src/logstore/writer.ts';
import { loadRoutes } from '../src/routes.ts';
import { MemorySharedStore } from '../src/stores.ts';
import type { UpstreamBuyer, UpstreamResult } from '../src/upstream.ts';

const PAY_TO = getAddress('0x2222222222222222222222222222222222222222');
const SETTLE_TX = '0x' + 'ab'.repeat(32);

/** 署名を本当に検証する偽の facilitator（JPYC の domain で ecrecover できるか）。呼ばれた順番を events に残す */
class FakeFacilitator implements FacilitatorClient {
  verifyCalls = 0;
  settleCalls = 0;
  settleResult: Partial<SettleResponse> = {};
  settleThrows = false;
  constructor(readonly events: string[], readonly name: string) {}
  async verify(p: PaymentPayload, r: PaymentRequirements): Promise<VerifyResponse> {
    this.verifyCalls++;
    this.events.push(`verify:${this.name}`);
    const { authorization: a, signature } = p.payload as any;
    const ok = await verifyTypedData({
      address: a.from,
      domain: { name: JPYC_EIP712.name, version: JPYC_EIP712.version, chainId: chainIdOf(r.network as JpycNetwork), verifyingContract: r.asset as `0x${string}` },
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
    this.events.push(`settle:${this.name}`);
    if (this.settleThrows) throw new Error('timeout');
    return { success: true, transaction: SETTLE_TX, network: r.network as any, payer: (p.payload as any).authorization.from, ...this.settleResult };
  }
  async getSupported(): Promise<SupportedResponse> {
    return { kinds: [], extensions: [], signers: {} } as any;
  }
}

class FakeUpstream implements UpstreamBuyer {
  calls: { url: string; cost: bigint }[] = [];
  result: Partial<UpstreamResult> = {};
  constructor(readonly events: string[]) {}
  async buy(url: string, cost: bigint): Promise<UpstreamResult> {
    this.calls.push({ url, cost });
    this.events.push('upstream');
    return {
      status: 200,
      body: new TextEncoder().encode(JSON.stringify({ source: 'up', url })),
      contentType: 'application/json',
      paid: cost > 0n,
      tx: cost > 0n ? '5SolanaSig' : undefined,
      ...this.result,
    };
  }
}

function setup(opts: { cap?: bigint } = {}) {
  const events: string[] = [];
  const facs = {
    [POLYGON_MAINNET]: new FakeFacilitator(events, 'polygon'),
    [AVALANCHE]: new FakeFacilitator(events, 'avalanche'),
    [KAIA]: new FakeFacilitator(events, 'kaia'),
  };
  const upstream = new FakeUpstream(events);
  const logs = new MemoryLogStore();
  const log = new PaymentLogWriter(logs, () => undefined);
  const store = new MemorySharedStore();
  const handle = createHandler({
    routes: loadRoutes({}),
    networks: [POLYGON_MAINNET, AVALANCHE, KAIA],
    facilitators: {
      [POLYGON_MAINNET]: { client: facs[POLYGON_MAINNET], kind: 'cdp' },
      [AVALANCHE]: { client: facs[AVALANCHE], kind: 'self' },
      [KAIA]: { client: facs[KAIA], kind: 'self' },
    },
    payTo: PAY_TO,
    publicBaseUrl: 'https://jpyc.x402jp.com',
    upstreamBaseUrls: { jin: 'https://jin.x402jp.com', osd: 'https://osd.x402jp.com' },
    upstream,
    log,
    store,
    upstreamDailyCapMicro: opts.cap,
  });
  const gwFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    const out: GatewayResponse = await handle({ method: req.method, path: u.pathname, search: u.search, header: (n) => req.headers.get(n) ?? undefined });
    return new Response(out.body as BodyInit, { status: out.status, headers: out.headers });
  }) as typeof fetch;
  const rows = async () => {
    await log.flush();
    return [...logs.files.values()].flatMap((t) => parseLines(t));
  };
  return { events, facs, upstream, gwFetch, rows, store };
}

function buyer(gwFetch: typeof fetch, network: JpycNetwork = POLYGON_MAINNET, pk = generatePrivateKey()) {
  const account = privateKeyToAccount(pk);
  const client = new x402Client();
  client.register(network, new ExactEvmScheme(account));
  client.setSpendControls({ maxAmountPerPayment: false, allowedAssets: [{ network, asset: JPYC_ADDRESS, maxAmountPerPayment: jpycToAtomic('20').toString() }] });
  client.registerPolicy((_v, reqs) => reqs.filter((r) => r.network === network));
  return { account, client, pay: wrapFetchWithPayment(gwFetch, client) };
}

test('402 の accepts に有効な全チェーン（Polygon・Avalanche・Kaia）が同じ金額・payTo・domain で並び、Bazaar の入出力が付く', async () => {
  const { gwFetch } = setup();
  const res = await gwFetch('https://jpyc.x402jp.com/jin/series');
  assert.equal(res.status, 402);
  const pr = decodePaymentRequiredHeader(res.headers.get('payment-required')!);
  assert.deepEqual(pr.accepts.map((a) => a.network), [POLYGON_MAINNET, AVALANCHE, KAIA]);
  for (const a of pr.accepts) {
    assert.equal(a.asset, JPYC_ADDRESS);
    assert.equal(a.amount, '2000000000000000000');
    assert.equal(a.payTo, PAY_TO);
    assert.ok(a.maxTimeoutSeconds <= 300);
    assert.deepEqual({ name: a.extra.name, version: a.extra.version }, { name: 'JPY Coin', version: '1' });
  }
  const bz = (pr.extensions as any).bazaar;
  assert.equal(bz.info.input.type, 'http');
  assert.equal(bz.info.input.method, 'GET');
  assert.ok(bz.info.output.example.series);
  assert.equal(pr.resource.url, 'https://jpyc.x402jp.com/jin/series');
});

test('順番は verify → 上流の仕入れ → settle。成功すればデータと PAYMENT-RESPONSE・X-PAYMENT-LOG を返す', async () => {
  const { gwFetch, rows, events, upstream } = setup();
  const { pay, account } = buyer(gwFetch);
  const res = await pay('https://jpyc.x402jp.com/jin/series?from=2026-10-01');
  assert.equal(res.status, 200);
  assert.deepEqual(events, ['verify:polygon', 'upstream', 'settle:polygon']);
  assert.equal(upstream.calls[0].url, 'https://jin.x402jp.com/api/jin/series?from=2026-10-01');
  assert.equal(decodePaymentResponseHeader(res.headers.get('payment-response')!).transaction, SETTLE_TX);
  const xlog = JSON.parse(Buffer.from(res.headers.get('x-payment-log')!, 'base64').toString());
  const r = (await rows())[0];
  assert.deepEqual(xlog, r);
  assert.equal(r.status, 'ok');
  assert.equal(r.flow, 'settle_last');
  assert.equal(r.payer, account.address);
  assert.equal(r.network, POLYGON_MAINNET);
  assert.equal(r.facilitator, 'cdp');
  assert.equal(r.upstream_cost_usd, 0.01);
});

test('Avalanche・Kaia の JPYC でも払え、そのチェーンの facilitator（自前ホスト）が使われる', async () => {
  for (const network of [AVALANCHE, KAIA] as const) {
    const { gwFetch, rows, facs } = setup();
    const { pay } = buyer(gwFetch, network);
    const res = await pay('https://jpyc.x402jp.com/jin/movers');
    assert.equal(res.status, 200);
    assert.equal(facs[network].settleCalls, 1);
    assert.equal(facs[POLYGON_MAINNET].verifyCalls, 0);
    const r = (await rows())[0];
    assert.equal(r.network, network);
    assert.equal(r.facilitator, 'self');
    assert.equal(r.price_jpyc, 3);
  }
});

test('上流の仕入れに失敗したら settle しない（買い手は払わない）。charged:false を返す', async () => {
  const s = setup();
  s.upstream.result = { status: 402, body: new Uint8Array(), paid: true, tx: undefined, error: 'upstream 402 after payment (simulation_failed)' };
  const { pay } = buyer(s.gwFetch);
  const res = await pay('https://jpyc.x402jp.com/jin/movers');
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.charged, false);
  assert.deepEqual(s.events, ['verify:polygon', 'upstream']);
  assert.equal(s.facs[POLYGON_MAINNET].settleCalls, 0);
  const r = (await s.rows())[0];
  assert.equal(r.status, 'upstream_failed');
  assert.equal(r.settle_tx, 'none');
  assert.equal(r.upstream_cost_usd, 0);
  assert.equal(r.flow, 'settle_last');
});

test('存在しない銘柄（上流が支払い前に 404）は 404・settle なし', async () => {
  const s = setup();
  s.upstream.result = { status: 404, body: new TextEncoder().encode('{"error":"ticker not found"}'), paid: false, tx: undefined, error: 'upstream 404' };
  const { pay } = buyer(s.gwFetch);
  const res = await pay('https://jpyc.x402jp.com/osd/catalyst/ZZZZ');
  assert.equal(res.status, 404);
  assert.equal((await res.json()).charged, false);
  assert.equal(s.upstream.calls[0].url, 'https://osd.x402jp.com/api/catalyst/ZZZZ');
  assert.equal(s.upstream.calls[0].cost, 1000n);
  assert.equal(s.facs[POLYGON_MAINNET].settleCalls, 0);
});

test('上流が請求しなかった（OSD の未調査銘柄）ときは settle せずに無料で返す', async () => {
  const s = setup();
  s.upstream.result = { paid: false, tx: undefined };
  const { pay } = buyer(s.gwFetch);
  const res = await pay('https://jpyc.x402jp.com/osd/catalyst/7212');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-charged'), 'false');
  assert.equal(s.facs[POLYGON_MAINNET].settleCalls, 0);
  assert.equal((await s.rows())[0].status, 'free');
});

test('仕入れ後に settle が失敗したら、データを返さず損失として記録し、その payer を 24 時間受け付けない', async () => {
  const s = setup();
  s.facs[POLYGON_MAINNET].settleResult = { success: false, transaction: '', errorReason: 'invalid_exact_evm_insufficient_balance' };
  const pk = generatePrivateKey();
  const { pay } = buyer(s.gwFetch, POLYGON_MAINNET, pk);
  const res = await pay('https://jpyc.x402jp.com/jin/series');
  assert.equal(res.status, 402);
  assert.ok(!(await res.text()).includes('"series"'));
  const r = (await s.rows())[0];
  assert.equal(r.status, 'settle_failed');
  assert.equal(r.upstream_tx, '5SolanaSig');
  assert.equal(r.upstream_cost_usd, 0.01);
  // 同じ payer の次の支払いは facilitator に投げずに弾く
  const verifies = s.facs[POLYGON_MAINNET].verifyCalls;
  const res2 = await buyer(s.gwFetch, POLYGON_MAINNET, pk).pay('https://jpyc.x402jp.com/jin/series');
  assert.equal(res2.status, 402);
  assert.equal(s.facs[POLYGON_MAINNET].verifyCalls, verifies);
  assert.match((await s.rows())[1].error, /payer_blocked/);
  // 別の payer は受け付けて verify まで進む（settle はこのテストでは失敗させたまま）
  await buyer(s.gwFetch).pay('https://jpyc.x402jp.com/jin/series');
  assert.equal(s.facs[POLYGON_MAINNET].verifyCalls, verifies + 1);
});

test('settle が例外（タイムアウト）でも同じく損失として記録する', async () => {
  const s = setup();
  s.facs[POLYGON_MAINNET].settleThrows = true;
  const res = await buyer(s.gwFetch).pay('https://jpyc.x402jp.com/jin/series');
  assert.equal(res.status, 402);
  assert.match((await s.rows())[0].error, /settle error: timeout/);
});

test('上流への支払いの日次上限を超えたら 503（上流も settle も呼ばない）', async () => {
  const s = setup({ cap: 15_000n }); // 0.015 USDC
  assert.equal((await buyer(s.gwFetch).pay('https://jpyc.x402jp.com/jin/series')).status, 200); // 0.01
  const res = await buyer(s.gwFetch).pay('https://jpyc.x402jp.com/jin/series'); // 0.02 > 0.015
  assert.equal(res.status, 503);
  assert.equal((await res.json()).charged, false);
  assert.equal(s.upstream.calls.length, 1);
  assert.equal(s.facs[POLYGON_MAINNET].settleCalls, 1);
  assert.equal(await s.store.spent(new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)), 10_000n);
});

test('同じ署名の再送は facilitator に投げる前に弾く（共有ストア）', async () => {
  const s = setup();
  const { client } = buyer(s.gwFetch);
  const pr = decodePaymentRequiredHeader((await s.gwFetch('https://jpyc.x402jp.com/jin/series')).headers.get('payment-required')!);
  const header = encodePaymentSignatureHeader(await client.createPaymentPayload(pr));
  assert.equal((await s.gwFetch('https://jpyc.x402jp.com/jin/series', { headers: { 'PAYMENT-SIGNATURE': header } })).status, 200);
  const again = await s.gwFetch('https://jpyc.x402jp.com/jin/series', { headers: { 'PAYMENT-SIGNATURE': header } });
  assert.equal(again.status, 402);
  assert.equal((await again.json()).error, 'nonce_replayed');
  assert.equal(s.facs[POLYGON_MAINNET].verifyCalls, 1);
});

test('value が提示額と違う・期限が 5 分より先・有効でないチェーンは verify に進まない', async () => {
  const s = setup();
  const { client } = buyer(s.gwFetch);
  const pr = decodePaymentRequiredHeader((await s.gwFetch('https://jpyc.x402jp.com/jin/series')).headers.get('payment-required')!);
  const polygonReq = pr.accepts[0];
  const cheap = await client.createPaymentPayload({ ...pr, accepts: [{ ...polygonReq, amount: jpycToAtomic('1').toString() }] });
  const r1 = await s.gwFetch('https://jpyc.x402jp.com/jin/series', { headers: { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader({ ...cheap, accepted: polygonReq }) } });
  assert.equal((await r1.json()).error, 'authorization_value_mismatch');
  const long = await client.createPaymentPayload({ ...pr, accepts: [{ ...polygonReq, maxTimeoutSeconds: 3600 }] });
  const r2 = await s.gwFetch('https://jpyc.x402jp.com/jin/series', { headers: { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader({ ...long, accepted: polygonReq }) } });
  assert.equal((await r2.json()).error, 'valid_before_too_far');
  const eth = await s.gwFetch('https://jpyc.x402jp.com/jin/series', { headers: { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader({ ...cheap, accepted: { ...polygonReq, network: 'eip155:1' } }) } });
  assert.equal((await eth.json()).error, 'network_not_accepted');
  assert.equal(s.facs[POLYGON_MAINNET].verifyCalls, 0);
});

test('/jin/latest は無料、不正な ticker・未知のパスは 404', async () => {
  const s = setup();
  assert.equal((await s.gwFetch('https://jpyc.x402jp.com/jin/latest')).status, 200);
  assert.equal((await s.gwFetch('https://jpyc.x402jp.com/osd/catalyst/a%2Fb')).status, 404);
  assert.equal((await s.gwFetch('https://jpyc.x402jp.com/osd/other')).status, 404);
  assert.equal((await s.rows()).length, 0);
});
