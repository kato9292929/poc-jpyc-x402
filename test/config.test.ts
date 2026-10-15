import { test } from 'node:test';
import assert from 'node:assert/strict';
import { facilitatorKindOf, loadGatewayConfig } from '../src/config.ts';
import { loadRoutes } from '../src/routes.ts';

const base = {
  FACILITATOR_URL: 'https://facilitator.example.test',
  JPYC_PAY_TO: '0x2222222222222222222222222222222222222222',
  UPSTREAM_SOLANA_PRIVATE_KEY: 'k',
  BLOB_READ_WRITE_TOKEN: 't',
};

test('LOG_SINK=file は NODE_ENV=development のときだけ', () => {
  assert.throws(() => loadGatewayConfig({ ...base, LOG_SINK: 'file' }), /development/);
  assert.equal(loadGatewayConfig({ ...base, LOG_SINK: 'file', NODE_ENV: 'development' }).logSink, 'file');
  assert.equal(loadGatewayConfig({ ...base }).logSink, 'blob');
});

test('買い手の鍵はゲートウェイに置かない・poc-card-credits の鍵と同じにしない', () => {
  assert.throws(() => loadGatewayConfig({ ...base, BUYER_PRIVATE_KEY: '0x1' }), /BUYER_PRIVATE_KEY/);
  assert.throws(() => loadGatewayConfig({ ...base, GATEWAY_WALLET_SECRET: 'k' }), /different key/);
});

test('ネットワークは Polygon / Amoy のみ', () => {
  assert.equal(loadGatewayConfig(base).network, 'eip155:137');
  assert.equal(loadGatewayConfig({ ...base, JPYC_NETWORK: 'eip155:80002' }).network, 'eip155:80002');
  assert.throws(() => loadGatewayConfig({ ...base, JPYC_NETWORK: 'eip155:1' }), /JPYC_NETWORK/);
});

test('facilitator の種別は URL から判定', () => {
  assert.equal(facilitatorKindOf('https://api.cdp.coinbase.com/platform/v2/x402'), 'cdp');
  assert.equal(facilitatorKindOf('https://jpyc-facilitator.example.com'), 'self');
  assert.equal(facilitatorKindOf('https://x.example', 'cdp'), 'cdp');
  assert.throws(() => loadGatewayConfig({ ...base, FACILITATOR_URL: 'https://api.cdp.coinbase.com/platform/v2/x402' }), /CDP_API_KEY/);
});

test('価格は環境変数で変えられる（初期値 2 / 3）', () => {
  const d = loadRoutes({});
  assert.deepEqual(d.map((r) => [r.path, r.priceJpyc]), [['/jin/latest', '0'], ['/jin/series', '2'], ['/jin/movers', '3']]);
  const c = loadRoutes({ PRICE_SERIES_JPYC: '5', PRICE_MOVERS_JPYC: '1.5' });
  assert.equal(c[1].priceJpyc, '5');
  assert.equal(c[2].priceJpyc, '1.5');
  assert.throws(() => loadRoutes({ PRICE_SERIES_JPYC: '0' }), /positive/);
});
