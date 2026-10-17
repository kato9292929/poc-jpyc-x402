import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey } from 'viem/accounts';
import { envFlag, runBuyer, type RecordStore } from '../src/buyer.ts';
import { createHandler, type GatewayResponse } from '../src/gateway/handler.ts';
import { MemoryLogStore } from '../src/logstore/memory.ts';
import { PaymentLogWriter } from '../src/logstore/writer.ts';
import { loadRoutes } from '../src/routes.ts';

class MemRecords implements RecordStore {
  logs = new MemoryLogStore();
  locks = new Set<string>();
  append(d: string, l: string) { return this.logs.append(d, l); }
  read(d: string) { return this.logs.read(d); }
  async tryLock(k: string) { if (this.locks.has(k)) return false; this.locks.add(k); return true; }
  async unlock(k: string) { this.locks.delete(k); }
}

function gateway(settleOk = true) {
  let settles = 0;
  const handle = createHandler({
    routes: loadRoutes({}),
    network: 'eip155:137',
    payTo: '0x2222222222222222222222222222222222222222',
    publicBaseUrl: 'https://gw.example',
    upstreamBaseUrl: 'https://jin.example',
    facilitator: {
      verify: async (p: any) => ({ isValid: true, payer: p.payload.authorization.from }),
      settle: async (_p: any, r: any) => (settles++, settleOk ? { success: true, transaction: '0x' + '1'.repeat(64), network: r.network } : { success: false, errorReason: 'x', transaction: '', network: r.network }),
      getSupported: async () => ({ kinds: [], extensions: [], signers: {} }),
    } as any,
    facilitatorKind: 'cdp',
    upstream: { buy: async () => ({ status: 200, body: new TextEncoder().encode('{"d":1}'), paid: true, tx: 'sol' }) },
    log: new PaymentLogWriter(new MemoryLogStore(), () => undefined),
  });
  const f = (async (input: any, init?: any) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    const out: GatewayResponse = await handle({ method: 'GET', path: u.pathname, search: u.search, header: (n) => req.headers.get(n) ?? undefined });
    return new Response(out.body as BodyInit, { status: out.status, headers: out.headers });
  }) as typeof fetch;
  return { f, settles: () => settles };
}

const base = (store: RecordStore, f: typeof fetch, over: object = {}) => ({
  privateKey: generatePrivateKey(), gatewayUrl: 'https://gw.example', store, fetch: f, log: () => undefined, ...over,
});

test('series と movers を 1 回ずつ買い、1 日 1 回なので同じ日の再実行では買わない', async () => {
  const store = new MemRecords();
  const g = gateway();
  const pk = generatePrivateKey();
  const r1 = await runBuyer(base(store, g.f, { privateKey: pk }));
  assert.deepEqual(r1.records.map((r) => [r.path, r.status, r.spent_jpyc]), [['/jin/series', 'ok', '2'], ['/jin/movers', 'ok', '3']]);
  assert.equal(r1.spentAfterJpyc, '5');
  assert.match(r1.records[0].polygonscan!, /^https:\/\/polygonscan\.com\/tx\/0x1+$/);
  const r2 = await runBuyer(base(store, g.f, { privateKey: pk }));
  assert.deepEqual(r2.records.map((r) => r.status), ['skipped_already_bought', 'skipped_already_bought']);
  assert.equal(r2.spentBeforeJpyc, '5');
  assert.equal(g.settles(), 2);
});

test('日次上限を超える支払いには署名せずに止まる', async () => {
  const store = new MemRecords();
  const g = gateway();
  const r = await runBuyer(base(store, g.f, { dailyCapJpyc: '4', oncePerDay: false }));
  assert.deepEqual(r.records.map((x) => [x.path, x.status, x.spent_jpyc]), [['/jin/series', 'ok', '2'], ['/jin/movers', 'cap_exceeded', '0']]);
  assert.equal(g.settles(), 1);
  // 上限は同じ日の記録から復元される
  const r2 = await runBuyer(base(store, g.f, { dailyCapJpyc: '4', oncePerDay: false, paths: ['/jin/series'] }));
  assert.equal(r2.records[0].status, 'ok');
  const r3 = await runBuyer(base(store, g.f, { dailyCapJpyc: '4', oncePerDay: false, paths: ['/jin/series'] }));
  assert.equal(r3.records[0].status, 'cap_exceeded');
});

test('送金されなかった失敗（settle 失敗の 402）は計上せず、ロックも外す', async () => {
  const store = new MemRecords();
  const g = gateway(false);
  const r = await runBuyer(base(store, g.f, { paths: ['/jin/series'] }));
  assert.equal(r.records[0].status, 'http_error');
  assert.equal(r.records[0].spent_jpyc, '0');
  assert.equal(store.locks.size, 0);
});

test('二重起動：ロックが取れなければ買わない', async () => {
  const store = new MemRecords();
  const g = gateway();
  await store.tryLock(`${new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)}/jin/series`);
  const r = await runBuyer(base(store, g.f, { paths: ['/jin/series'] }));
  assert.equal(r.records[0].status, 'skipped_already_bought');
  assert.equal(g.settles(), 0);
});

test('BUYER_ONCE_PER_DAY は 1 / true / 0 / false', () => {
  assert.equal(envFlag('1', false), true);
  assert.equal(envFlag('true', false), true);
  assert.equal(envFlag('0', true), false);
  assert.equal(envFlag(undefined, true), true);
  assert.throws(() => envFlag('maybe', true));
});
