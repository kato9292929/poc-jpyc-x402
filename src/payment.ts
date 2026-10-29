import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { getAddress, isAddress } from 'viem';
import { JPYC_ADDRESS, JPYC_EIP712, jpycToAtomic, type JpycNetwork } from './jpyc.ts';
import type { NonceCache } from './nonce.ts';

/** 署名の有効期限の上限（指示書 §7：validBefore は署名時刻から 5 分以内） */
export const MAX_TIMEOUT_SECONDS = 300;
/** 買い手とゲートウェイの時計のずれの許容 */
const CLOCK_SKEW_SECONDS = 30;
/** facilitator が settle するまでに残っていてほしい時間（SDK の facilitator も 6 秒未満を拒否する） */
const MIN_REMAINING_SECONDS = 6;

export function buildRequirements(args: { network: JpycNetwork; payTo: string; priceJpyc: string }): PaymentRequirements {
  return {
    scheme: 'exact',
    network: args.network,
    asset: JPYC_ADDRESS,
    amount: jpycToAtomic(args.priceJpyc).toString(),
    payTo: getAddress(args.payTo),
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { name: JPYC_EIP712.name, version: JPYC_EIP712.version, assetTransferMethod: 'eip3009' },
  };
}

export function buildPaymentRequired(args: {
  url: string;
  description: string;
  /** 1 件、またはチェーンごとに並べた複数件（買い手はどれか 1 つで払う） */
  requirements: PaymentRequirements | PaymentRequirements[];
  error?: string;
  /** Bazaar などの拡張（カタログ用の入力・出力の形） */
  extensions?: Record<string, unknown>;
}): PaymentRequired {
  return {
    x402Version: 2,
    error: args.error ?? 'Payment required',
    resource: { url: args.url, description: args.description, mimeType: 'application/json' },
    accepts: Array.isArray(args.requirements) ? args.requirements : [args.requirements],
    ...(args.extensions ? { extensions: args.extensions } : {}),
  };
}

interface Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export type PrecheckResult =
  | { ok: true; payer: string; authorization: Authorization; validBefore: number }
  | { ok: false; payer: string; reason: string };

const isUintString = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v);

/**
 * facilitator の /verify に投げる前の、ゲートウェイ側の検査（指示書 §7）。
 * - 402 で提示した要求（ネットワーク・資産・受取先・金額）と一致しているか
 * - authorization.value が提示額と完全一致しているか（文字列として一致。"2e18" や先頭 0 も不可）
 * - nonce が 32 バイト、validBefore が 5 分以内
 * - 同じ nonce を直近に受け取っていないか（nonces を渡したとき。最後に確認し、通ったものだけ記録する）
 */
export function precheckPayment(
  payload: PaymentPayload,
  req: PaymentRequirements,
  nonces: NonceCache | undefined,
  nowSec = Math.floor(Date.now() / 1000),
): PrecheckResult {
  const auth = (payload?.payload as { authorization?: Partial<Authorization> } | undefined)?.authorization;
  const payer = typeof auth?.from === 'string' && isAddress(auth.from) ? getAddress(auth.from) : 'unknown';
  const fail = (reason: string): PrecheckResult => ({ ok: false, payer, reason });

  if (payload?.x402Version !== 2) return fail('unsupported_x402_version');
  const acc = payload.accepted;
  if (!acc || acc.scheme !== req.scheme) return fail('scheme_mismatch');
  if (acc.network !== req.network) return fail('network_mismatch');
  if (typeof acc.asset !== 'string' || acc.asset.toLowerCase() !== req.asset.toLowerCase()) return fail('asset_mismatch');
  if (typeof acc.payTo !== 'string' || acc.payTo.toLowerCase() !== req.payTo.toLowerCase()) return fail('pay_to_mismatch');
  if (acc.amount !== req.amount) return fail('amount_mismatch');

  if (!auth) return fail('missing_authorization');
  if (typeof (payload.payload as { signature?: unknown }).signature !== 'string') return fail('missing_signature');
  if (payer === 'unknown') return fail('invalid_from');
  if (typeof auth.to !== 'string' || !isAddress(auth.to) || auth.to.toLowerCase() !== req.payTo.toLowerCase()) {
    return fail('authorization_to_mismatch');
  }
  if (auth.value !== req.amount) return fail('authorization_value_mismatch');
  if (!isUintString(auth.validAfter) || !isUintString(auth.validBefore)) return fail('invalid_validity_window');
  const validAfter = Number(auth.validAfter);
  const validBefore = Number(auth.validBefore);
  if (validAfter > nowSec + CLOCK_SKEW_SECONDS) return fail('not_yet_valid');
  if (validBefore < nowSec + MIN_REMAINING_SECONDS) return fail('authorization_expired');
  if (validBefore > nowSec + MAX_TIMEOUT_SECONDS + CLOCK_SKEW_SECONDS) return fail('valid_before_too_far');
  if (typeof auth.nonce !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(auth.nonce)) return fail('invalid_nonce');
  if (/^0x0{64}$/.test(auth.nonce)) return fail('invalid_nonce');

  // nonces を渡さないときは、呼び出し側が共有ストアで再送を確かめる（Vercel では関数の間で共有するため）
  if (nonces && !nonces.claim(auth.nonce, validBefore)) return fail('nonce_replayed');
  return { ok: true, payer, authorization: auth as Authorization, validBefore };
}
