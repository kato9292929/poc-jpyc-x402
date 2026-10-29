/**
 * 受け付けるチェーンの定義（指示書4 §4）。JPYC はどのチェーンでも同じアドレス・同じ domain。
 *
 *   Polygon    facilitator = CDP（/supported に exact あり）
 *   Avalanche  CDP の /supported に無い（2026-10-29 確認）→ 自前ホスト（relayer がガスを払う）
 *   Kaia       同上 → 自前ホスト
 *   Ethereum   CDP の /supported に無い → 無効（自前ホストだとガス代が価格を超えるため。指示書の決定）
 *
 * 有効にするチェーンは ENABLED_NETWORKS（カンマ区切り）で決める。自前ホストのチェーンは relayer の鍵が要る。
 */
import type { Chain } from 'viem';
import { avalanche, kaia, mainnet, polygon, polygonAmoy } from 'viem/chains';
import { AVALANCHE, ETHEREUM, KAIA, POLYGON_AMOY, POLYGON_MAINNET, type JpycNetwork } from './jpyc.ts';

export interface NetworkSpec {
  network: JpycNetwork;
  label: string;
  chain: Chain;
  /** 既定の公開 RPC（RPC_URL_<KEY> で上書き） */
  defaultRpc: string;
  /** 環境変数名の接尾辞（RPC_URL_POLYGON / RELAYER_PRIVATE_KEY_AVALANCHE など） */
  key: string;
  /** facilitator：cdp = CDP、self = このゲートウェイ内の参照実装 + relayer */
  facilitator: 'cdp' | 'self';
}

export const NETWORK_SPECS: Record<JpycNetwork, NetworkSpec> = {
  [POLYGON_MAINNET]: { network: POLYGON_MAINNET, label: 'Polygon', chain: polygon, defaultRpc: 'https://polygon-bor-rpc.publicnode.com', key: 'POLYGON', facilitator: 'cdp' },
  [POLYGON_AMOY]: { network: POLYGON_AMOY, label: 'Polygon Amoy', chain: polygonAmoy, defaultRpc: 'https://polygon-amoy-bor-rpc.publicnode.com', key: 'AMOY', facilitator: 'self' },
  [AVALANCHE]: { network: AVALANCHE, label: 'Avalanche', chain: avalanche, defaultRpc: 'https://api.avax.network/ext/bc/C/rpc', key: 'AVALANCHE', facilitator: 'self' },
  [KAIA]: { network: KAIA, label: 'Kaia', chain: kaia, defaultRpc: 'https://public-en.node.kaia.io', key: 'KAIA', facilitator: 'self' },
  [ETHEREUM]: { network: ETHEREUM, label: 'Ethereum', chain: mainnet, defaultRpc: 'https://ethereum-rpc.publicnode.com', key: 'ETHEREUM', facilitator: 'cdp' },
};

export const DEFAULT_ENABLED_NETWORKS: JpycNetwork[] = [POLYGON_MAINNET, AVALANCHE];

export function rpcUrlOf(network: JpycNetwork, env: NodeJS.ProcessEnv = process.env): string {
  const spec = NETWORK_SPECS[network];
  // 旧設定（Polygon だけだった頃の POLYGON_RPC_URL）も読む
  return env[`RPC_URL_${spec.key}`] || (network === POLYGON_MAINNET ? env.POLYGON_RPC_URL : undefined) || spec.defaultRpc;
}

export function parseEnabledNetworks(v: string | undefined): JpycNetwork[] {
  if (!v) return DEFAULT_ENABLED_NETWORKS;
  const out = v.split(',').map((s) => s.trim()).filter(Boolean) as JpycNetwork[];
  for (const n of out) if (!NETWORK_SPECS[n]) throw new Error(`ENABLED_NETWORKS: unknown network ${n}`);
  if (!out.length) throw new Error('ENABLED_NETWORKS is empty');
  return out;
}
