/**
 * 買い手の JPYC 残高（Polygon）と上流購入用ウォレットの USDC 残高（Solana）を読み、計画分に足りるかを返す。
 * 定期実行で「翌日分に足りなくなったら支払わずに終了」に使う（指示書3）。
 */
import { createPublicClient, erc20Abi, http } from 'viem';
import { polygon } from 'viem/chains';
import { JPYC_ADDRESS, atomicToJpyc } from './jpyc.ts';
import { SOLANA_USDC } from './upstream.ts';

export async function solanaUsdcAtomic(rpcUrl: string, owner: string, f: typeof fetch = fetch): Promise<bigint> {
  const res = await f(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [owner, { mint: SOLANA_USDC }, { encoding: 'jsonParsed' }] }),
  });
  const j = (await res.json()) as any;
  if (j.error) throw new Error(`solana rpc: ${JSON.stringify(j.error)}`);
  return (j.result?.value ?? []).reduce((s: bigint, v: any) => s + BigInt(v.account.data.parsed.info.tokenAmount.amount), 0n);
}

export function makeCheckFunds(opts: { polygonRpcUrl: string; solanaRpcUrl: string; upstreamSolanaAddress: string }) {
  const pc = createPublicClient({ chain: polygon, transport: http(opts.polygonRpcUrl) });
  return async (needJpyc: bigint, needUsdc: bigint, buyer: string): Promise<string | undefined> => {
    const jpyc = await pc.readContract({ address: JPYC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [buyer as `0x${string}`] });
    const usdc = await solanaUsdcAtomic(opts.solanaRpcUrl, opts.upstreamSolanaAddress);
    console.log(`[funds] JPYC ${atomicToJpyc(jpyc)} (need ${atomicToJpyc(needJpyc)}), upstream USDC ${Number(usdc) / 1e6} (need ${Number(needUsdc) / 1e6})`);
    if (jpyc < needJpyc) return `insufficient JPYC: ${atomicToJpyc(jpyc)} < ${atomicToJpyc(needJpyc)}`;
    if (usdc < needUsdc) return `insufficient upstream USDC: ${Number(usdc) / 1e6} < ${Number(needUsdc) / 1e6}`;
    return undefined;
  };
}
