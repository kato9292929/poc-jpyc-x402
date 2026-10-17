import { HTTPFacilitatorClient, type FacilitatorClient } from '@x402/core/http';
import { createCdpAuthHeaders } from '@coinbase/x402';
import type { FacilitatorKind } from './log.ts';

/**
 * FACILITATOR_URL の facilitator（/verify・/settle・/supported）に繋ぐ。
 * A = CDP（CDP の JWT 認証ヘッダ）、B = 自前ホスト（Bearer トークン。vercel/facilitator）。どちらも x402 v2 の HTTP API。
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
