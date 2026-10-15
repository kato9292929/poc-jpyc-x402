import { HTTPFacilitatorClient, type FacilitatorClient } from '@x402/core/http';
import { createCdpAuthHeaders } from '@coinbase/x402';
import type { FacilitatorKind } from './log.ts';

/**
 * FACILITATOR_URL の facilitator（/verify・/settle・/supported）に繋ぐ。
 * A = CDP（認証ヘッダが要る）、B = 自前ホスト（OSS の JPYC 用 facilitator 等）。どちらも x402 v2 の HTTP API で同じコードで動く。
 */
export function createFacilitator(args: {
  url: string;
  kind: FacilitatorKind;
  cdpApiKeyId?: string;
  cdpApiKeySecret?: string;
  timeoutMs?: number;
}): FacilitatorClient {
  return new HTTPFacilitatorClient({
    url: args.url,
    timeoutMs: args.timeoutMs ?? 60_000,
    createAuthHeaders: args.kind === 'cdp' ? createCdpAuthHeaders(args.cdpApiKeyId, args.cdpApiKeySecret) : undefined,
  });
}

/** /supported に network + exact が載っているか */
export async function supportsExact(f: FacilitatorClient, network: string): Promise<boolean> {
  const s = await f.getSupported();
  return s.kinds.some((k) => k.x402Version === 2 && k.scheme === 'exact' && (k.network === network || k.network === 'eip155:*'));
}
