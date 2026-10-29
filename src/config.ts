import 'dotenv/config';
import { getAddress, isAddress } from 'viem';
import type { JpycNetwork } from './jpyc.ts';
import type { FacilitatorKind } from './log.ts';
import { NETWORK_SPECS, parseEnabledNetworks, rpcUrlOf } from './networks.ts';
import { usdToUsdcAtomic } from './routes.ts';

export function required(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = env[name];
  if (!v) throw new Error(`missing required env var ${name} (see .env.example)`);
  return v;
}

export const CDP_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';

export interface NetworkConfig {
  network: JpycNetwork;
  rpcUrl: string;
  facilitator: FacilitatorKind;
  /** facilitator = self のときの relayer の鍵（チェーンごとに別の鍵） */
  relayerPrivateKey?: `0x${string}`;
}

export interface GatewayConfig {
  port: number;
  /** 買い手から見たゲートウェイの公開 URL（402 の resource.url に入る） */
  publicBaseUrl: string;
  networks: NetworkConfig[];
  /** CDP の facilitator（Polygon）。FACILITATOR_URL で上書き可（テスト用） */
  facilitatorUrl: string;
  cdpApiKeyId?: string;
  cdpApiKeySecret?: string;
  /** 自前ホストの facilitator が受け付ける 1 回あたりの上限（JPYC） */
  relayerMaxJpyc: string;
  payTo: `0x${string}`;
  upstreamJinBaseUrl: string;
  upstreamOsdBaseUrl: string;
  upstreamSolanaPrivateKey: string;
  /** 上流への支払いの日次上限（USDC atomic） */
  upstreamDailyCapMicro: bigint;
  /** 共有ストア：blob = Vercel Blob（本番）、memory = プロセス内（ローカル・テスト） */
  stateStore: 'blob' | 'memory';
  logSink: 'blob' | 'file';
  blobReadWriteToken?: string;
  logDir: string;
  /** OpenAPI の x-payment-info（USD 建て）に入れる参考レート */
  jpycUsdRate: number;
}

/** 旧設定（FACILITATOR_URL の種別判定）との互換のため残す */
export function facilitatorKindOf(url: string, explicit?: string): FacilitatorKind {
  if (explicit === 'cdp' || explicit === 'self') return explicit;
  if (explicit) throw new Error(`FACILITATOR_KIND must be cdp or self, got ${explicit}`);
  return /(^|\.)cdp\.coinbase\.com$/.test(new URL(url).hostname) ? 'cdp' : 'self';
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  // 買い手の鍵はゲートウェイに置かない（§6）。誤って同じ .env を使っていたら起動しない
  if (env.BUYER_PRIVATE_KEY) {
    throw new Error('BUYER_PRIVATE_KEY must not be set in the gateway environment (buyer script only)');
  }
  // 受取用の秘密鍵はどこにも置かない
  if (env.PAYTO_PRIVATE_KEY) throw new Error('PAYTO_PRIVATE_KEY must not be set in the gateway environment');

  const enabled = parseEnabledNetworks(env.ENABLED_NETWORKS || env.JPYC_NETWORK);
  const networks: NetworkConfig[] = enabled.map((network) => {
    const spec = NETWORK_SPECS[network];
    const relayer = env[`RELAYER_PRIVATE_KEY_${spec.key}`];
    if (spec.facilitator === 'self' && !relayer) {
      throw new Error(`${spec.label} uses the self-hosted facilitator: set RELAYER_PRIVATE_KEY_${spec.key} (a separate key per chain)`);
    }
    return { network, rpcUrl: rpcUrlOf(network, env), facilitator: spec.facilitator, relayerPrivateKey: relayer as `0x${string}` | undefined };
  });
  const relayerKeys = networks.map((n) => n.relayerPrivateKey).filter((k): k is `0x${string}` => !!k);
  if (new Set(relayerKeys.map((k) => k.toLowerCase())).size !== relayerKeys.length) {
    throw new Error('relayer keys must be different for each chain');
  }

  const payToRaw = required('JPYC_PAY_TO', env);
  if (!isAddress(payToRaw)) throw new Error(`JPYC_PAY_TO is not an EVM address: ${payToRaw}`);

  const upstreamKey = required('UPSTREAM_SOLANA_PRIVATE_KEY', env);
  // poc-card-credits のゲートウェイ鍵と同じ鍵を使わない（§6）。同じ環境に両方あれば比べて止める
  if (env.GATEWAY_WALLET_SECRET && env.GATEWAY_WALLET_SECRET === upstreamKey) {
    throw new Error('UPSTREAM_SOLANA_PRIVATE_KEY must be a different key from poc-card-credits (GATEWAY_WALLET_SECRET)');
  }

  const port = Number(env.PORT || 8788);
  const logSink = (env.LOG_SINK || 'blob') as 'blob' | 'file';
  const cfg: GatewayConfig = {
    port,
    publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    networks,
    facilitatorUrl: (env.FACILITATOR_URL || CDP_FACILITATOR_URL).replace(/\/+$/, ''),
    cdpApiKeyId: env.CDP_API_KEY_ID || undefined,
    cdpApiKeySecret: env.CDP_API_KEY_SECRET || undefined,
    relayerMaxJpyc: env.RELAYER_MAX_JPYC || '10',
    payTo: getAddress(payToRaw),
    upstreamJinBaseUrl: (env.UPSTREAM_JIN_BASE_URL || 'https://jin.x402jp.com').replace(/\/+$/, ''),
    upstreamOsdBaseUrl: (env.UPSTREAM_OSD_BASE_URL || 'https://osd.x402jp.com').replace(/\/+$/, ''),
    upstreamSolanaPrivateKey: upstreamKey,
    upstreamDailyCapMicro: usdToUsdcAtomic(env.UPSTREAM_DAILY_CAP_USD || '2'),
    stateStore: (env.STATE_STORE || (logSink === 'file' ? 'memory' : 'blob')) as 'blob' | 'memory',
    logSink,
    blobReadWriteToken: env.BLOB_READ_WRITE_TOKEN || undefined,
    logDir: env.LOG_DIR || 'log',
    jpycUsdRate: Number(env.JPYC_USD_RATE || '0.0066'),
  };
  // CDP のキーが無いと verify が認証エラーで落ちる（支払いは起きない）。402 の確認だけ先に行えるよう、起動は止めずに警告する
  if (networks.some((n) => n.facilitator === 'cdp') && (!cfg.cdpApiKeyId || !cfg.cdpApiKeySecret)) {
    console.warn('[config] CDP facilitator without CDP_API_KEY_ID / CDP_API_KEY_SECRET: verify will fail until they are set');
  }
  if (cfg.logSink !== 'blob' && cfg.logSink !== 'file') throw new Error('LOG_SINK must be blob or file');
  if (cfg.stateStore !== 'blob' && cfg.stateStore !== 'memory') throw new Error('STATE_STORE must be blob or memory');
  // ローカルファイルへの出力は開発時だけ（poc-card-credits と同じ規則）
  if (cfg.logSink === 'file' && env.NODE_ENV !== 'development' && env.GITHUB_ACTIONS !== 'true') {
    throw new Error('LOG_SINK=file is for local development or the GitHub Actions daily run only');
  }
  // プロセス内のストアは関数の間で共有できない。公開環境（Vercel）では使わない
  if (cfg.stateStore === 'memory' && env.VERCEL) throw new Error('STATE_STORE=memory is not allowed on Vercel (use blob)');
  if ((cfg.logSink === 'blob' || cfg.stateStore === 'blob') && !cfg.blobReadWriteToken) {
    throw new Error('missing BLOB_READ_WRITE_TOKEN (logs and shared state go to Vercel Blob)');
  }
  return cfg;
}
