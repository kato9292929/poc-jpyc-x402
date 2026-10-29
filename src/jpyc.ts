/**
 * JPYC（JPY Coin）の固定値と金額変換（指示書 §2）。
 * 金額の変換はこのファイルの jpycToAtomic / atomicToJpyc の2関数だけで行う。ほかの場所で 10 ** 18 を書かないこと。
 */

/** mainnet・testnet 共通のコントラクト */
export const JPYC_ADDRESS = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29' as const;

/** 1 JPYC = 10^18。USDC の 6 ではない */
export const JPYC_DECIMALS = 18;

/**
 * EIP-712 domain。facilitator 側の設定と食い違うと署名検証で落ちる。
 * 2026-10 に mainnet / Amoy の両方で、この domain で署名した transferWithAuthorization が
 * 署名検証を通ることを確かめた（npm run jpyc:domain-check）。
 */
export const JPYC_EIP712 = { name: 'JPY Coin', version: '1' } as const;

export const POLYGON_MAINNET = 'eip155:137' as const;
export const POLYGON_AMOY = 'eip155:80002' as const;
export const AVALANCHE = 'eip155:43114' as const;
export const KAIA = 'eip155:8217' as const;
export const ETHEREUM = 'eip155:1' as const;
export type JpycNetwork = typeof POLYGON_MAINNET | typeof POLYGON_AMOY | typeof AVALANCHE | typeof KAIA | typeof ETHEREUM;
/** JPYC が同じアドレスで発行されていて、domain（"JPY Coin" / "1"）の署名が通ることを確かめたチェーン（2026-10-29） */
export const JPYC_NETWORKS: readonly JpycNetwork[] = [POLYGON_MAINNET, POLYGON_AMOY, AVALANCHE, KAIA, ETHEREUM];

const CHAIN_IDS: Record<JpycNetwork, number> = {
  [POLYGON_MAINNET]: 137,
  [POLYGON_AMOY]: 80002,
  [AVALANCHE]: 43114,
  [KAIA]: 8217,
  [ETHEREUM]: 1,
};
const EXPLORERS: Record<JpycNetwork, string> = {
  [POLYGON_MAINNET]: 'https://polygonscan.com/tx/',
  [POLYGON_AMOY]: 'https://amoy.polygonscan.com/tx/',
  [AVALANCHE]: 'https://snowtrace.io/tx/',
  [KAIA]: 'https://kaiascan.io/tx/',
  [ETHEREUM]: 'https://etherscan.io/tx/',
};

export function chainIdOf(network: JpycNetwork): number {
  const id = CHAIN_IDS[network];
  if (!id) throw new Error(`unknown JPYC network ${network}`);
  return id;
}

/** tx のエクスプローラー URL（関数名は Polygon だけだった頃の名残。全チェーン対応） */
export function polygonscanTxUrl(network: JpycNetwork, tx: string): string {
  return `${EXPLORERS[network] ?? EXPLORERS[POLYGON_MAINNET]}${tx}`;
}
export const explorerTxUrl = polygonscanTxUrl;

const UNIT = 10n ** BigInt(JPYC_DECIMALS);

/** "2" / "0.5" のような10進文字列の JPYC を atomic（10^-18 単位）の bigint にする。小数19桁以上・負数は拒否。 */
export function jpycToAtomic(jpyc: string | number): bigint {
  const s = String(jpyc).trim();
  const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(s);
  if (!m) throw new Error(`invalid JPYC amount: "${s}"`);
  return BigInt(m[1]) * UNIT + BigInt((m[2] ?? '').padEnd(JPYC_DECIMALS, '0'));
}

/** atomic の JPYC を10進文字列にする（末尾の 0 は落とす。2000000000000000000 → "2"）。 */
export function atomicToJpyc(atomic: bigint | string): string {
  const a = typeof atomic === 'bigint' ? atomic : BigInt(atomic);
  if (a < 0n) throw new Error('negative JPYC amount');
  const whole = a / UNIT;
  const frac = (a % UNIT).toString().padStart(JPYC_DECIMALS, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}
