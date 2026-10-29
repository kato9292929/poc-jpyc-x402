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
  assert.deepEqual(c, { jpyc_not_received: 0, upstream_before_payment: 0, upstream_after_payment: 1, upstream_paid_no_data: 0, settle_failed_after_upstream: 0 });
});

test('新しい順番（flow=settle_last）：settle の失敗は上流原価の損失、上流の失敗では JPYC を受け取っていない', async () => {
  const { jpycReceived } = await import('../src/failures.ts');
  const lost = { status: 'settle_failed', flow: 'settle_last', upstream_tx: '5Sig', settle_tx: 'none' };
  assert.equal(classifyFailure(lost), 'settle_failed_after_upstream');
  assert.equal(jpycReceived(lost), false);
  const upNew = { status: 'upstream_failed', flow: 'settle_last', upstream_tx: 'none', error: 'upstream 402 after payment' };
  assert.equal(classifyFailure(upNew), 'upstream_after_payment');
  assert.equal(jpycReceived(upNew), false);
  // 旧方式の行（10/26 の実例）は JPYC 受領済み
  assert.equal(jpycReceived({ status: 'upstream_failed', upstream_tx: 'none', error: 'upstream 402 after payment' }), true);
  assert.equal(classifyFailure({ status: 'free', flow: 'settle_last' }), undefined);
  assert.equal(jpycReceived({ status: 'free', flow: 'settle_last' }), false);
});
