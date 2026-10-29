/**
 * 同じ支払い署名を同時に N 本、公開ゲートウェイに送る（nonce の共有記録が同時送信でも 1 回しか通さないかの確認）。
 * 存在しない銘柄（/osd/catalyst/ZZZZ）を使うので、上流は 404 → settle しない。買い手の JPYC も上流の USDC も動かない。
 *   DOTENV_CONFIG_PATH=.env.buyer npx tsx scripts/replay-race.ts [N] [network]
 * 期待：1 本が 404（not_found_upstream、X-CHARGED: false）、残りが 402（nonce_replayed）
 */
import 'dotenv/config';
import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import { JPYC_ADDRESS } from '../src/jpyc.ts';

const N = Number(process.argv[2] ?? 20);
const network = (process.argv[3] ?? 'eip155:137') as `${string}:${string}`;
const url = `${(process.env.GATEWAY_URL || 'https://jpyc.x402jp.com').replace(/\/+$/, '')}/osd/catalyst/ZZZZ`;
const account = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as `0x${string}`);

const first = await fetch(url);
if (first.status !== 402) throw new Error(`expected 402, got ${first.status}`);
const pr = decodePaymentRequiredHeader(first.headers.get('payment-required')!);
pr.accepts = pr.accepts.filter((a) => a.network === network);
const client = new x402Client();
client.register(network, new ExactEvmScheme(account));
// JPYC だけ、1 JPYC まで
client.setSpendControls({ maxAmountPerPayment: false, allowedAssets: [{ network, asset: JPYC_ADDRESS, maxAmountPerPayment: '1000000000000000000' }] });
const header = encodePaymentSignatureHeader(await client.createPaymentPayload(pr));

const res = await Promise.all(
  Array.from({ length: N }, async () => {
    const r = await fetch(url, { headers: { 'PAYMENT-SIGNATURE': header } });
    const body = await r.text();
    const reason = /"(?:reason|error)":"([^"]+)"/.exec(body)?.[1] ?? '';
    if (N === 1) console.log('server-timing:', r.headers.get('server-timing'));
    return `${r.status} ${reason} charged=${r.headers.get('x-charged') ?? '-'}`;
  }),
);
const counts: Record<string, number> = {};
for (const x of res) counts[x] = (counts[x] ?? 0) + 1;
console.log(JSON.stringify({ url, network, n: N, results: counts }, null, 2));
