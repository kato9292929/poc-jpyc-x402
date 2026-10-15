import 'dotenv/config';
import { getAddress, isAddress } from 'viem';
import { JPYC_NETWORKS, POLYGON_MAINNET, type JpycNetwork } from './jpyc.ts';
import type { FacilitatorKind } from './log.ts';

export function required(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = env[name];
  if (!v) throw new Error(`missing required env var ${name} (see .env.example)`);
  return v;
}

export interface GatewayConfig {
  port: number;
  /** 買い手から見たゲートウェイの公開 URL（402 の resource.url に入る） */
  publicBaseUrl: string;
  network: JpycNetwork;
  facilitatorUrl: string;
  facilitatorKind: FacilitatorKind;
  cdpApiKeyId?: string;
  cdpApiKeySecret?: string;
  polygonRpcUrl?: string;
  payTo: `0x${string}`;
  upstreamJinBaseUrl: string;
  upstreamSolanaPrivateKey: string;
  logSink: 'blob' | 'file';
  blobReadWriteToken?: string;
  logDir: string;
}

/** FACILITATOR_KIND 未指定なら URL から判定する（CDP のホストなら cdp、それ以外は自前ホスト＝self） */
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
  const network = (env.JPYC_NETWORK || POLYGON_MAINNET) as JpycNetwork;
  if (!JPYC_NETWORKS.includes(network)) throw new Error(`JPYC_NETWORK must be one of ${JPYC_NETWORKS.join(', ')}, got ${network}`);

  const payToRaw = required('JPYC_PAY_TO', env);
  if (!isAddress(payToRaw)) throw new Error(`JPYC_PAY_TO is not an EVM address: ${payToRaw}`);

  const upstreamKey = required('UPSTREAM_SOLANA_PRIVATE_KEY', env);
  // poc-card-credits のゲートウェイ鍵と同じ鍵を使わない（§6）。同じ環境に両方あれば比べて止める
  if (env.GATEWAY_WALLET_SECRET && env.GATEWAY_WALLET_SECRET === upstreamKey) {
    throw new Error('UPSTREAM_SOLANA_PRIVATE_KEY must be a different key from poc-card-credits (GATEWAY_WALLET_SECRET)');
  }

  const facilitatorUrl = required('FACILITATOR_URL', env).replace(/\/+$/, '');
  const port = Number(env.PORT || 8788);
  const cfg: GatewayConfig = {
    port,
    publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    network,
    facilitatorUrl,
    facilitatorKind: facilitatorKindOf(facilitatorUrl, env.FACILITATOR_KIND || undefined),
    cdpApiKeyId: env.CDP_API_KEY_ID || undefined,
    cdpApiKeySecret: env.CDP_API_KEY_SECRET || undefined,
    polygonRpcUrl: env.POLYGON_RPC_URL || undefined,
    payTo: getAddress(payToRaw),
    upstreamJinBaseUrl: (env.UPSTREAM_JIN_BASE_URL || 'https://jin.x402jp.com').replace(/\/+$/, ''),
    upstreamSolanaPrivateKey: upstreamKey,
    logSink: (env.LOG_SINK || 'blob') as 'blob' | 'file',
    blobReadWriteToken: env.BLOB_READ_WRITE_TOKEN || undefined,
    logDir: env.LOG_DIR || 'log',
  };
  if (cfg.facilitatorKind === 'cdp' && (!cfg.cdpApiKeyId || !cfg.cdpApiKeySecret)) {
    throw new Error('CDP facilitator requires CDP_API_KEY_ID and CDP_API_KEY_SECRET');
  }
  if (cfg.logSink !== 'blob' && cfg.logSink !== 'file') throw new Error('LOG_SINK must be blob or file');
  // ローカルファイルへの出力は開発時だけ（poc-card-credits と同じ規則）
  if (cfg.logSink === 'file' && env.NODE_ENV !== 'development') {
    throw new Error('LOG_SINK=file is for local development only (requires NODE_ENV=development)');
  }
  if (cfg.logSink === 'blob' && !cfg.blobReadWriteToken) {
    throw new Error('missing BLOB_READ_WRITE_TOKEN (gateway logs go to Vercel Blob, same as poc-card-credits)');
  }
  return cfg;
}
