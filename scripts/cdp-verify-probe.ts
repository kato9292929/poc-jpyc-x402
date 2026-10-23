/**
 * facilitator（FACILITATOR_URL）に、使い捨ての鍵で署名した JPYC の支払いを verify だけ投げる（settle しない・送金しない）。
 * JPYC を受け付ける facilitator なら、残高不足（insufficient_balance 系）で落ちるのが正しい結果。
 * 資産を受け付けない場合は別の理由（unsupported asset 等）で落ちる。
 * 使い方: DOTENV_CONFIG_PATH=.env.gateway npx tsx scripts/cdp-verify-probe.ts
 */
import 'dotenv/config';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { facilitatorKindOf, required } from '../src/config.ts';
import { createFacilitator } from '../src/facilitator.ts';
import { POLYGON_MAINNET, type JpycNetwork } from '../src/jpyc.ts';
import { buildPaymentRequired, buildRequirements } from '../src/payment.ts';

const url = required('FACILITATOR_URL').replace(/\/+$/, '');
const kind = facilitatorKindOf(url, process.env.FACILITATOR_KIND || undefined);
const f = createFacilitator({ url, kind, cdpApiKeyId: process.env.CDP_API_KEY_ID, cdpApiKeySecret: process.env.CDP_API_KEY_SECRET, bearerToken: process.env.FACILITATOR_AUTH_TOKEN });
const network = (process.env.JPYC_NETWORK || POLYGON_MAINNET) as JpycNetwork;
const req = buildRequirements({ network, payTo: required('JPYC_PAY_TO'), priceJpyc: '2' });
const client = new x402Client().register(network, new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())));
client.setSpendControls(false);
const payload = await client.createPaymentPayload(buildPaymentRequired({ url: 'http://localhost/jin/series', description: 'probe', requirements: req }));
try {
  console.log(JSON.stringify(await f.verify(payload, req)));
} catch (e) {
  console.log(`verify threw: ${(e as Error).message}`, JSON.stringify((e as { response?: unknown }).response ?? ''));
}
