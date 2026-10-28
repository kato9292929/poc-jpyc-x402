import { x402Client, x402HTTPClient } from '@x402/core/client';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { base58 } from '@scure/base';

type PaymentRequired = Awaited<ReturnType<x402HTTPClient['getPaymentRequiredResponse']>>;

/** Solana mainnet と、そこでの USDC（JIN が 402 で提示する資産） */
export const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export interface UpstreamResult {
  /** 上流の最終 HTTP ステータス（0 = 届かなかった） */
  status: number;
  body: Uint8Array;
  contentType?: string;
  /** 上流購入の Solana tx（PAYMENT-RESPONSE の transaction） */
  tx?: string;
  /** 支払いを署名して送ったか */
  paid: boolean;
  error?: string;
}

export interface UpstreamBuyer {
  readonly address?: string;
  /** expectedCostAtomic = 0 のときは支払わない（402 が返れば失敗） */
  buy(url: string, expectedCostAtomic: bigint): Promise<UpstreamResult>;
}

/**
 * JIN を既存の x402（Solana / USDC）で1コールずつ購入する（poc-card-credits のゲートウェイと同じ方式）。
 * 402 の要求を自前で検査し、Solana mainnet の USDC で、ルートに設定した原価と完全一致する場合だけ署名する。
 */
export class JinUpstreamBuyer implements UpstreamBuyer {
  private constructor(
    private readonly client: x402Client,
    private readonly http: x402HTTPClient,
    readonly address: string,
    private readonly fetchImpl: typeof fetch,
    private readonly timeoutMs: number,
  ) {}

  static async create(opts: { svmPrivateKey: string; fetch?: typeof fetch; timeoutMs?: number }): Promise<JinUpstreamBuyer> {
    const signer = await createKeyPairSignerFromBytes(base58.decode(opts.svmPrivateKey));
    const client = new x402Client();
    client.register('solana:*', new ExactSvmScheme(signer));
    // 二重の安全装置：JIN の最高額 $0.02 より少し上で止める
    client.setSpendControls({ maxAmountPerPayment: '$0.05' });
    return new JinUpstreamBuyer(client, new x402HTTPClient(client), signer.address, opts.fetch ?? fetch, opts.timeoutMs ?? 30_000);
  }

  async buy(url: string, expectedCostAtomic: bigint): Promise<UpstreamResult> {
    const signal = () => AbortSignal.timeout(this.timeoutMs);
    const read = async (res: Response, extra: Partial<UpstreamResult>): Promise<UpstreamResult> => ({
      status: res.status,
      body: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? undefined,
      paid: false,
      ...extra,
    });
    const fail = (status: number, error: string, paid = false): UpstreamResult => ({ status, body: new Uint8Array(), paid, error });

    let first: Response;
    try {
      first = await this.fetchImpl(url, { signal: signal() });
    } catch (e) {
      return fail(0, `upstream unreachable: ${(e as Error).message}`);
    }
    if (first.status !== 402) {
      return read(first, first.ok ? {} : { error: `upstream ${first.status}` });
    }
    if (expectedCostAtomic === 0n) return fail(402, 'upstream asked for payment on a free route');

    let pr: PaymentRequired;
    try {
      const text = await first.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        /* ヘッダのみの 402 */
      }
      pr = this.http.getPaymentRequiredResponse((n) => first.headers.get(n), body);
    } catch (e) {
      return fail(402, `cannot parse upstream 402: ${(e as Error).message}`);
    }

    const chosen = pr.accepts.find(
      (r) =>
        r.scheme === 'exact' &&
        r.network === SOLANA_MAINNET &&
        r.asset === SOLANA_USDC &&
        (r as { amount?: string }).amount === expectedCostAtomic.toString(),
    );
    if (!chosen) {
      const offered = pr.accepts.map((r) => `${(r as { amount?: string }).amount}@${r.network}/${r.asset}`).join(', ');
      return fail(402, `upstream requirement mismatch: offered [${offered}], expected ${expectedCostAtomic} USDC atomic on Solana`);
    }

    let sent = false;
    try {
      const payload = await this.client.createPaymentPayload({ ...pr, accepts: [chosen] });
      const headers = new Headers(this.http.encodePaymentSignatureHeader(payload));
      sent = true;
      const second = await this.fetchImpl(url, { headers, signal: signal() });
      let settled: { success: boolean; transaction?: string; errorReason?: string } | undefined;
      try {
        settled = this.http.getPaymentSettleResponse((n) => second.headers.get(n));
      } catch {
        settled = undefined;
      }
      const ok = second.ok && !!settled?.success;
      // 支払いを送ったのに上流が失敗したときは、上流が示した理由を残す（x402 v2 は 402 の PAYMENT-REQUIRED の error、
      // それ以外は本文の先頭）。10/26 の JIN の「支払い後の 402」で理由が分からなかったため（poc-card-credits c404cd4 と同じ）
      let upstreamReason: string | undefined;
      if (!second.ok) {
        try {
          const prh = second.headers.get('payment-required');
          if (prh) upstreamReason = JSON.parse(Buffer.from(prh, 'base64').toString('utf8'))?.error;
        } catch {
          upstreamReason = undefined;
        }
        if (!upstreamReason) {
          upstreamReason = (await second.clone().text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200) || undefined;
        }
      }
      return read(second, {
        paid: true,
        tx: settled?.transaction || undefined,
        error: ok
          ? undefined
          : `upstream ${second.status} after payment${settled?.errorReason ? `: ${settled.errorReason}` : ''}${upstreamReason ? ` (${upstreamReason})` : ''}`,
      });
    } catch (e) {
      // 送る前に失敗したか（署名の作成など）、送った後に失敗したか（通信が途中で切れた等）を分けて残す
      return fail(0, sent ? `upstream payment failed after sending: ${(e as Error).message}` : `upstream payment not sent: ${(e as Error).message}`, sent);
    }
  }
}
