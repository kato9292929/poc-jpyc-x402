import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, countFailures } from '../src/failures.ts';

test('失敗をお金の動きで 4 つの型に分ける', () => {
  assert.equal(classifyFailure({ status: 'ok' }), undefined);
  assert.equal(classifyFailure({ status: 'verify_failed', error: 'verify: invalid_exact_evm_insufficient_balance' }), 'jpyc_not_received');
  assert.equal(classifyFailure({ status: 'settle_failed' }), 'jpyc_not_received');
  assert.equal(classifyFailure({ status: 'upstream_failed', upstream_tx: 'none', error: 'upstream 503' }), 'upstream_before_payment');
  assert.equal(classifyFailure({ status: 'upstream_failed', upstream_tx: 'none', error: 'upstream requirement mismatch: ...' }), 'upstream_before_payment');
  assert.equal(classifyFailure({ status: 'upstream_failed', upstream_tx: 'none', error: 'upstream payment not sent: rpc' }), 'upstream_before_payment');
  // 10/26 の実例
  assert.equal(classifyFailure({ status: 'upstream_failed', upstream_tx: 'none', error: 'upstream 402 after payment' }), 'upstream_after_payment');
  assert.equal(classifyFailure({ status: 'upstream_failed', upstream_tx: 'none', error: 'upstream payment failed after sending: socket hang up' }), 'upstream_after_payment');
  assert.equal(classifyFailure({ status: 'upstream_failed', upstream_tx: '5Sig', error: 'upstream 500 after payment' }), 'upstream_paid_no_data');
});

test('型ごとの件数（0 件の型も出す）', () => {
  const c = countFailures([{ status: 'ok' }, { status: 'upstream_failed', upstream_tx: 'none', error: 'upstream 402 after payment' }]);
  assert.deepEqual(c, { jpyc_not_received: 0, upstream_before_payment: 0, upstream_after_payment: 1, upstream_paid_no_data: 0 });
});
