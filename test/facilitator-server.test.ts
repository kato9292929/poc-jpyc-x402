import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedRequirement, loadFacilitatorServerConfig } from '../src/facilitator-server.ts';
import { buildRequirements } from '../src/payment.ts';

const PAY_TO = '0x2222222222222222222222222222222222222222';
const cfg = loadFacilitatorServerConfig({
  POLYGON_RPC_URL: 'http://rpc', RELAYER_PRIVATE_KEY: '0x' + '1'.repeat(64),
  FACILITATOR_AUTH_TOKEN: 'x'.repeat(40), FACILITATOR_ALLOWED_PAY_TO: PAY_TO,
});

test('B は自分の受取先・JPYC・Polygon・上限以下の金額だけ受け付ける（relayer のガスを守る）', () => {
  const ok = buildRequirements({ network: 'eip155:137', payTo: PAY_TO, priceJpyc: '2' });
  assert.equal(allowedRequirement(cfg, ok), undefined);
  assert.equal(allowedRequirement(cfg, { ...ok, payTo: '0x3333333333333333333333333333333333333333' }), 'pay_to_not_allowed');
  assert.equal(allowedRequirement(cfg, { ...ok, asset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' }), 'asset_not_allowed');
  assert.equal(allowedRequirement(cfg, { ...ok, network: 'eip155:8453' }), 'network_not_allowed');
  assert.equal(allowedRequirement(cfg, { ...ok, amount: (11n * 10n ** 18n).toString() }), 'amount_not_allowed');
  assert.equal(allowedRequirement(cfg, { ...ok, extra: { ...ok.extra, assetTransferMethod: 'permit2' } }), 'permit2_not_allowed');
});

test('B の設定：短いトークン・買い手の鍵の同居は起動しない', () => {
  const env = { POLYGON_RPC_URL: 'x', RELAYER_PRIVATE_KEY: '0x1', FACILITATOR_ALLOWED_PAY_TO: PAY_TO };
  assert.throws(() => loadFacilitatorServerConfig({ ...env, FACILITATOR_AUTH_TOKEN: 'short' }), /32/);
  assert.throws(() => loadFacilitatorServerConfig({ ...env, FACILITATOR_AUTH_TOKEN: 'x'.repeat(40), BUYER_PRIVATE_KEY: '0x2' }), /BUYER/);
});
