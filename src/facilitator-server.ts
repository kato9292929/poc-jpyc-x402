/**
 * B：自前ホストの facilitator（x402 の参照実装 @x402/core + @x402/evm）。CDP が通らなかったときに使う。
 * relayer ウォレットが POL でガスを払い、JPYC の transferWithAuthorization を送る。
 *
 * relayer のガスを他人に使わせないため、次のものしか受け付けない：
 * - Bearer FACILITATOR_AUTH_TOKEN（ゲートウェイだけが持つ）
 * - ネットワークは JPYC_NETWORK、資産は JPYC、受取は FACILITATOR_ALLOWED_PAY_TO、金額は FACILITATOR_MAX_JPYC 以下
 */
import express from 'express';
import { x402Facilitator } from '@x402/core/facilitator';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm/exact/facilitator';
import { createWalletClient, getAddress, http, isAddress, publicActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon, polygonAmoy } from 'viem/chains';
import { timingSafeEqual } from 'node:crypto';
import { JPYC_ADDRESS, JPYC_NETWORKS, POLYGON_MAINNET, jpycToAtomic, type JpycNetwork } from './jpyc.ts';

export interface FacilitatorServerConfig {
  network: JpycNetwork;
  rpcUrl: string;
  relayerPrivateKey: `0x${string}`;
  authToken: string;
  allowedPayTo: string[];
  maxAtomic: bigint;
}

export function loadFacilitatorServerConfig(env: NodeJS.ProcessEnv = process.env): FacilitatorServerConfig {
  const need = (n: string) => {
    const v = env[n];
    if (!v) throw new Error(`missing ${n}`);
    return v;
  };
  const network = (env.JPYC_NETWORK || POLYGON_MAINNET) as JpycNetwork;
  if (!JPYC_NETWORKS.includes(network)) throw new Error(`JPYC_NETWORK must be one of ${JPYC_NETWORKS.join(', ')}`);
  const authToken = need('FACILITATOR_AUTH_TOKEN');
  if (authToken.length < 32) throw new Error('FACILITATOR_AUTH_TOKEN must be at least 32 characters');
  const allowedPayTo = need('FACILITATOR_ALLOWED_PAY_TO').split(',').map((s) => s.trim()).filter(Boolean);
  for (const a of allowedPayTo) if (!isAddress(a)) throw new Error(`FACILITATOR_ALLOWED_PAY_TO: not an address ${a}`);
  if (env.BUYER_PRIVATE_KEY) throw new Error('BUYER_PRIVATE_KEY must not be set in the facilitator environment');
  return {
    network,
    rpcUrl: need('POLYGON_RPC_URL'),
    relayerPrivateKey: need('RELAYER_PRIVATE_KEY') as `0x${string}`,
    authToken,
    allowedPayTo: allowedPayTo.map((a) => getAddress(a)),
    maxAtomic: jpycToAtomic(env.FACILITATOR_MAX_JPYC || '10'),
  };
}

/** 受け付けてよい要求か（relayer のガスを守るための絞り込み） */
export function allowedRequirement(cfg: FacilitatorServerConfig, req: PaymentRequirements | undefined): string | undefined {
  if (!req) return 'missing_requirements';
  if (req.scheme !== 'exact') return 'scheme_not_allowed';
  if (req.network !== cfg.network) return 'network_not_allowed';
  if (typeof req.asset !== 'string' || req.asset.toLowerCase() !== JPYC_ADDRESS.toLowerCase()) return 'asset_not_allowed';
  if (typeof req.payTo !== 'string' || !cfg.allowedPayTo.some((a) => a.toLowerCase() === req.payTo.toLowerCase())) return 'pay_to_not_allowed';
  if (!/^\d+$/.test(String(req.amount)) || BigInt(req.amount) <= 0n || BigInt(req.amount) > cfg.maxAtomic) return 'amount_not_allowed';
  if ((req.extra as { assetTransferMethod?: string } | undefined)?.assetTransferMethod === 'permit2') return 'permit2_not_allowed';
  return undefined;
}

export function createFacilitatorApp(cfg: FacilitatorServerConfig) {
  const account = privateKeyToAccount(cfg.relayerPrivateKey);
  const client = createWalletClient({ account, chain: cfg.network === POLYGON_MAINNET ? polygon : polygonAmoy, transport: http(cfg.rpcUrl) }).extend(
    publicActions,
  );
  const signer = toFacilitatorEvmSigner(Object.assign(client, { address: account.address }) as never, { confirmationTimeoutMs: 45_000 });
  const facilitator = new x402Facilitator().register(cfg.network, new ExactEvmScheme(signer));

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  const expected = Buffer.from(`Bearer ${cfg.authToken}`);
  app.use((req, res, next) => {
    if (req.path === '/healthz') return next();
    const got = Buffer.from(req.get('authorization') ?? '');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return res.status(401).json({ error: 'unauthorized' });
    next();
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true, network: cfg.network, relayer: account.address }));
  app.get('/supported', (_req, res) => res.json(facilitator.getSupported()));

  const body = (req: express.Request) => req.body as { paymentPayload?: PaymentPayload; paymentRequirements?: PaymentRequirements };
  app.post('/verify', async (req, res) => {
    const { paymentPayload, paymentRequirements } = body(req);
    const bad = allowedRequirement(cfg, paymentRequirements);
    if (bad || !paymentPayload) return res.json({ isValid: false, invalidReason: bad ?? 'missing_payload' });
    try {
      res.json(await facilitator.verify(paymentPayload, paymentRequirements!));
    } catch (e) {
      res.status(500).json({ isValid: false, invalidReason: 'unexpected_verify_error', invalidMessage: (e as Error).message });
    }
  });
  app.post('/settle', async (req, res) => {
    const { paymentPayload, paymentRequirements } = body(req);
    const bad = allowedRequirement(cfg, paymentRequirements);
    if (bad || !paymentPayload) {
      return res.json({ success: false, errorReason: bad ?? 'missing_payload', transaction: '', network: paymentRequirements?.network ?? cfg.network });
    }
    try {
      res.json(await facilitator.settle(paymentPayload, paymentRequirements!));
    } catch (e) {
      console.error('[facilitator] settle error', e);
      res.status(500).json({ success: false, errorReason: 'unexpected_settle_error', errorMessage: (e as Error).message, transaction: '', network: cfg.network });
    }
  });
  return { app, relayer: account.address };
}
