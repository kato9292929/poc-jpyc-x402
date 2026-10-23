/**
 * 実証で使うウォレットの残高（Polygon: JPYC / POL、Solana: USDC / SOL）。アドレスだけを引数に取る（鍵は読まない）。
 * 使い方: npm run balances -- --polygon 0x...,0x... --solana <addr>
 */
import { createPublicClient, erc20Abi, formatEther, http } from 'viem';
import { polygon } from 'viem/chains';
import { JPYC_ADDRESS, atomicToJpyc } from '../src/jpyc.ts';
import { SOLANA_USDC } from '../src/upstream.ts';

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1].split(',').filter(Boolean) : [];
};
const pc = createPublicClient({ chain: polygon, transport: http(process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com') });
for (const a of arg('--polygon')) {
  const [j, p] = await Promise.all([
    pc.readContract({ address: JPYC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [a as `0x${string}`] }),
    pc.getBalance({ address: a as `0x${string}` }),
  ]);
  console.log(`polygon ${a}  JPYC ${atomicToJpyc(j)}  POL ${formatEther(p)}`);
}
const sol = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const rpc = async (method: string, params: unknown[]) =>
  (await (await fetch(sol, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as any;
for (const a of arg('--solana')) {
  const s = await rpc('getBalance', [a]);
  const t = await rpc('getTokenAccountsByOwner', [a, { mint: SOLANA_USDC }, { encoding: 'jsonParsed' }]);
  const usdc = (t.result?.value ?? []).reduce((x: number, v: any) => x + Number(v.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
  console.log(`solana  ${a}  USDC ${usdc}  SOL ${(s.result?.value ?? 0) / 1e9}`);
}
