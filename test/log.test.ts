import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jstDay, jstIso, toLogLine, type PaymentLogEntry } from '../src/log.ts';

const entry = (over: Partial<PaymentLogEntry> = {}): PaymentLogEntry => ({
  ts: jstIso(new Date('2026-10-15T15:30:00Z')),
  endpoint: '/jin/series',
  price_jpyc: 2,
  payer: '0x1111111111111111111111111111111111111111',
  pay_to: '0x2222222222222222222222222222222222222222',
  network: 'eip155:137',
  facilitator: 'cdp',
  settle_tx: '0xabc',
  settle_ms: 1234,
  upstream_cost_usd: 0.01,
  upstream_tx: '5sig',
  status: 'ok',
  ...over,
});

test('日付の区切りは JST（UTC 15:00 で日付が変わる）', () => {
  assert.equal(jstDay(new Date('2026-10-15T14:59:59Z')), '2026-10-15');
  assert.equal(jstDay(new Date('2026-10-15T15:00:00Z')), '2026-10-16');
  assert.equal(jstIso(new Date('2026-10-15T15:30:00Z')), '2026-10-16T00:30:00.000+09:00');
});

test('1 行の JSON は指示書の項目順で、必須項目がそろう', () => {
  const line = toLogLine(entry());
  assert.ok(!line.includes('\n'));
  assert.deepEqual(Object.keys(JSON.parse(line)), [
    'ts', 'endpoint', 'price_jpyc', 'payer', 'pay_to', 'network', 'facilitator',
    'settle_tx', 'settle_ms', 'upstream_cost_usd', 'upstream_tx', 'status',
  ]);
});

test('欠けた項目・UTC の ts・ok なのに tx なしは書かない', () => {
  assert.throws(() => toLogLine(entry({ payer: '' })), /payer/);
  assert.throws(() => toLogLine(entry({ ts: '2026-10-15T15:30:00.000Z' })), /JST/);
  assert.throws(() => toLogLine(entry({ settle_tx: 'none' })), /status=ok/);
  assert.doesNotThrow(() => toLogLine(entry({ status: 'verify_failed', settle_tx: 'none', upstream_tx: 'none', error: 'x\ny' })));
});
