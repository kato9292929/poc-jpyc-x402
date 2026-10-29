/**
 * x402scan に公開ゲートウェイを登録する（SIWX のウォレット署名。お金は動かない）。
 *   DOTENV_CONFIG_PATH=.env.buyer npx tsx scripts/x402scan-register.ts [origin]
 */
import 'dotenv/config';
import { createSIWxPayload, encodeSIWxHeader } from '@x402/extensions/sign-in-with-x';
import { privateKeyToAccount } from 'viem/accounts';

const origin = process.argv[2] ?? 'https://jpyc.x402jp.com';
const url = 'https://www.x402scan.com/api/x402/registry/register-origin';
const account = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as `0x${string}`);
const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin }) };

const first = await fetch(url, init);
const ch = (await first.json()) as any;
const info = ch.extensions?.['sign-in-with-x']?.info;
if (first.status !== 402 || !info) throw new Error(`unexpected ${first.status}`);
const payload = await createSIWxPayload(info, account as never, url);
const res = await fetch(url, { ...init, headers: { ...init.headers, 'SIGN-IN-WITH-X': encodeSIWxHeader(payload) } });
console.log(res.status, (await res.text()).slice(0, 2000));
