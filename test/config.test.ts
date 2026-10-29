import { test } from 'node:test';
import assert from 'node:assert/strict';
import { facilitatorKindOf, loadGatewayConfig } from '../src/config.ts';
import { loadRoutes } from '../src/routes.ts';

const base = {
  ENABLED_NETWORKS: 'eip155:137',
  JPYC_PAY_TO: '0x2222222222222222222222222222222222222222',
  UPSTREAM_SOLANA_PRIVATE_KEY: 'k',
  BLOB_READ_WRITE_TOKEN: 't',
};

test('LOG_SINK=file は NODE_ENV=development のときだけ', () => {
  assert.throws(() => loadGatewayConfig({ ...base, LOG_SINK: 'file' }), /development/);
  assert.equal(loadGatewayConfig({ ...base, LOG_SINK: 'file', NODE_ENV: 'development' }).logSink, 'file');
  assert.equal(loadGatewayConfig({ ...base }).logSink, 'blob');
  assert.equal(loadGatewayConfig({ ...base, LOG_SINK: 'file', GITHUB_ACTIONS: 'true' }).logSink, 'file');
});

test('買い手の鍵はゲートウェイに置かない・poc-card-credits の鍵と同じにしない', () => {
  assert.throws(() => loadGatewayConfig({ ...base, BUYER_PRIVATE_KEY: '0x1' }), /BUYER_PRIVATE_KEY/);
  assert.throws(() => loadGatewayConfig({ ...base, GATEWAY_WALLET_SECRET: 'k' }), /different key/);
});

test('チェーン：既定は Polygon（CDP）・Avalanche・Kaia（自前ホスト、チェーンごとに別の relayer 鍵）', () => {
  const relayers = { RELAYER_PRIVATE_KEY_AVALANCHE: '0x' + '1'.repeat(64), RELAYER_PRIVATE_KEY_KAIA: '0x' + '2'.repeat(64) };
  const all = { ...base, ENABLED_NETWORKS: '' };
  const c = loadGatewayConfig({ ...all, ...relayers });
  assert.deepEqual(c.networks.map((n) => [n.network, n.facilitator]), [['eip155:137', 'cdp'], ['eip155:43114', 'self'], ['eip155:8217', 'self']]);
  assert.throws(() => loadGatewayConfig({ ...all, RELAYER_PRIVATE_KEY_KAIA: relayers.RELAYER_PRIVATE_KEY_KAIA }), /RELAYER_PRIVATE_KEY_AVALANCHE/);
  assert.throws(() => loadGatewayConfig({ ...all, RELAYER_PRIVATE_KEY_AVALANCHE: '0x' + '1'.repeat(64), RELAYER_PRIVATE_KEY_KAIA: '0x' + '1'.repeat(64) }), /different/);
  assert.deepEqual(loadGatewayConfig({ ...base, ENABLED_NETWORKS: 'eip155:137' }).networks.map((n) => n.network), ['eip155:137']);
  assert.throws(() => loadGatewayConfig({ ...base, ENABLED_NETWORKS: 'eip155:999' }), /unknown network/);
});

test('受取用の鍵は置かない・Vercel ではプロセス内のストアを使わない・上流の日次上限は既定 2 USDC', () => {
  const one = { ...base, ENABLED_NETWORKS: 'eip155:137' };
  assert.throws(() => loadGatewayConfig({ ...one, PAYTO_PRIVATE_KEY: '0x1' }), /PAYTO_PRIVATE_KEY/);
  assert.throws(() => loadGatewayConfig({ ...one, STATE_STORE: 'memory', VERCEL: '1' }), /not allowed on Vercel/);
  assert.equal(loadGatewayConfig(one).upstreamDailyCapMicro, 2_000_000n);
  assert.equal(loadGatewayConfig(one).stateStore, 'blob');
});

test('facilitator の種別は URL から判定（旧設定の互換）', () => {
  assert.equal(facilitatorKindOf('https://api.cdp.coinbase.com/platform/v2/x402'), 'cdp');
  assert.equal(facilitatorKindOf('https://jpyc-facilitator.example.com'), 'self');
  assert.equal(facilitatorKindOf('https://x.example', 'cdp'), 'cdp');
});

test('価格は環境変数で変えられる（初期値 2 / 3）', () => {
  const d = loadRoutes({});
  assert.deepEqual(d.map((r) => [r.path, r.priceJpyc]), [['/jin/latest', '0'], ['/jin/series', '2'], ['/jin/movers', '3'], ['/osd/catalyst/{ticker}', '1']]);
  const c = loadRoutes({ PRICE_SERIES_JPYC: '5', PRICE_MOVERS_JPYC: '1.5' });
  assert.equal(c[1].priceJpyc, '5');
  assert.equal(c[2].priceJpyc, '1.5');
  assert.throws(() => loadRoutes({ PRICE_SERIES_JPYC: '0' }), /positive/);
});
