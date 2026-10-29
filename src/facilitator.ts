import { HTTPFacilitatorClient, type FacilitatorClient } from '@x402/core/http';
import { createCdpAuthHeaders } from '@coinbase/x402';
import type { FacilitatorKind } from './log.ts';

/**
 * FACILITATOR_URL の facilitator（/verify・/settle・/supported）に繋ぐ。
 * A = CDP（CDP の JWT 認証ヘッダ）、B = 自前ホスト（Bearer トークン。src/facilitator-server.ts）。どちらも x402 v2 の HTTP API。
 */
export function createFacilitator(args: {
  url: string;
  kind: FacilitatorKind;
  cdpApiKeyId?: string;
  cdpApiKeySecret?: string;
  bearerToken?: string;
  timeoutMs?: number;
}): FacilitatorClient {
  const bearer = args.bearerToken
    ? async () => {
        const h = { Authorization: `Bearer ${args.bearerToken}` };
        return { verify: h, settle: h, supported: h };
      }
    : undefined;
  return new HTTPFacilitatorClient({
    url: args.url,
    timeoutMs: args.timeoutMs ?? 50_000,
    createAuthHeaders: args.kind === 'cdp' ? createCdpAuthHeaders(args.cdpApiKeyId, args.cdpApiKeySecret) : bearer,
  });
}

/** /supported に network + exact が載っているか */
export async function supportsExact(f: FacilitatorClient, network: string): Promise<boolean> {
  const s = await f.getSupported();
  return s.kinds.some((k) => k.x402Version === 2 && k.scheme === 'exact' && (k.network === network || k.network === 'eip155:*'));
}

/**
 * チェーンごとの facilitator（指示書4 §4）。Polygon = CDP、Avalanche・Kaia = このゲートウェイの中の参照実装 + チェーンごとの relayer。
 * 自前ホストは JPYC・自社の payTo・上限額以下の要求しか扱わない（relayer のガスを守る）。
 */
export async function createNetworkFacilitators(cfg: import('./config.ts').GatewayConfig) {
  const { createLocalFacilitatorClient } = await import('./facilitator-server.ts');
  const { jpycToAtomic } = await import('./jpyc.ts');
  const out: Partial<Record<import('./jpyc.ts').JpycNetwork, { client: FacilitatorClient; kind: FacilitatorKind; relayer?: string }>> = {};
  let cdp: FacilitatorClient | undefined;
  for (const n of cfg.networks) {
    if (n.facilitator === 'cdp') {
      cdp ??= createFacilitator({ url: cfg.facilitatorUrl, kind: 'cdp', cdpApiKeyId: cfg.cdpApiKeyId, cdpApiKeySecret: cfg.cdpApiKeySecret });
      out[n.network] = { client: cdp, kind: 'cdp' };
    } else {
      const local = createLocalFacilitatorClient({
        network: n.network,
        rpcUrl: n.rpcUrl,
        relayerPrivateKey: n.relayerPrivateKey!,
        authToken: 'in-process',
        allowedPayTo: [cfg.payTo],
        maxAtomic: jpycToAtomic(cfg.relayerMaxJpyc),
      });
      out[n.network] = { client: local, kind: 'self', relayer: local.relayer };
    }
  }
  return out;
}
