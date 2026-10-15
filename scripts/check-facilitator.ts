/**
 * facilitator の選定（指示書 §3）の 1 段目：/supported に exact + 対象ネットワークが載っているかを表示する。
 * 使い方: FACILITATOR_URL=... [CDP_API_KEY_ID=... CDP_API_KEY_SECRET=...] npm run facilitator:check
 * 2 段目（JPYC で実際に verify / settle が通るか）は、ゲートウェイを起動して買い手スクリプトで 1 件買って確かめる。
 */
import 'dotenv/config';
import { facilitatorKindOf, required } from '../src/config.ts';
import { createFacilitator } from '../src/facilitator.ts';
import { POLYGON_MAINNET } from '../src/jpyc.ts';

const url = required('FACILITATOR_URL').replace(/\/+$/, '');
const kind = facilitatorKindOf(url, process.env.FACILITATOR_KIND || undefined);
const network = process.env.JPYC_NETWORK || POLYGON_MAINNET;
const f = createFacilitator({ url, kind, cdpApiKeyId: process.env.CDP_API_KEY_ID, cdpApiKeySecret: process.env.CDP_API_KEY_SECRET });

try {
  const s = await f.getSupported();
  const evm = s.kinds.filter((k) => k.network.startsWith('eip155:'));
  console.log(`facilitator=${url} kind=${kind}`);
  for (const k of evm) console.log(`  v${k.x402Version} ${k.scheme.padEnd(16)} ${k.network}${k.extra ? ' ' + JSON.stringify(k.extra) : ''}`);
  const hit = s.kinds.some((k) => k.x402Version === 2 && k.scheme === 'exact' && (k.network === network || k.network === 'eip155:*'));
  console.log(hit ? `OK: exact on ${network} is supported` : `NG: exact on ${network} is NOT listed`);
  process.exit(hit ? 0 : 1);
} catch (e) {
  console.error(`NG: /supported failed: ${(e as Error).message}`);
  process.exit(2);
}
