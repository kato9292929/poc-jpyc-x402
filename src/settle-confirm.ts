/**
 * settle の結果が「失敗」や例外でも、チェーン上では送金が済んでいることがある
 * （2026-11-06：CDP が settlement_pending を返したが、3 秒後に tx が確定していた）。
 * そこで、署名（EIP-3009）の nonce が使用済みになったかをチェーンで確かめる。使用済みなら送金は済んでいる。
 */
import { createPublicClient, http, parseAbiItem, type Hex } from 'viem';
import { JPYC_ADDRESS, type JpycNetwork } from './jpyc.ts';
import { NETWORK_SPECS } from './networks.ts';

export interface SettleConfirmation {
  /** nonce が使用済み = 買い手の JPYC は動いた */
  used: boolean;
  /** 見つかれば送金の tx */
  tx?: string;
}

export type ConfirmSettlement = (network: JpycNetwork, payer: string, nonce: string) => Promise<SettleConfirmation>;

const authorizationStateAbi = [
  { type: 'function', name: 'authorizationState', stateMutability: 'view', inputs: [{ name: 'authorizer', type: 'address' }, { name: 'nonce', type: 'bytes32' }], outputs: [{ type: 'bool' }] },
] as const;
const authorizationUsed = parseAbiItem('event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)');

/** 最大 timeoutMs まで intervalMs ごとに nonce の状態を見る */
export function createSettleConfirmer(rpcUrls: Partial<Record<JpycNetwork, string>>, opts: { timeoutMs?: number; intervalMs?: number } = {}): ConfirmSettlement {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  return async (network, payer, nonce) => {
    const client = createPublicClient({ chain: NETWORK_SPECS[network].chain, transport: http(rpcUrls[network]) });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const used = await client
        .readContract({ address: JPYC_ADDRESS, abi: authorizationStateAbi, functionName: 'authorizationState', args: [payer as Hex, nonce as Hex] })
        .catch(() => false);
      if (used) {
        const head = await client.getBlockNumber().catch(() => undefined);
        const logs = head
          ? await client
              .getLogs({ address: JPYC_ADDRESS, event: authorizationUsed, args: { authorizer: payer as Hex, nonce: nonce as Hex }, fromBlock: head > 500n ? head - 500n : 0n, toBlock: head })
              .catch(() => [])
          : [];
        return { used: true, tx: logs[0]?.transactionHash };
      }
      if (Date.now() + intervalMs > deadline) return { used: false };
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
}
