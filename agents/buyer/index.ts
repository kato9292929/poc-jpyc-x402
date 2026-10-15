/**
 * 買い手エージェント（指示書 §4 Phase 1・2）。JPYC（Polygon）でゲートウェイの /jin/series・/jin/movers を買う。
 * 1 回の実行で BUYER_PATHS を 1 回ずつ購入して終わる。1 日 1 回の定期実行は cron 等で起動する（README）。
 *
 * - 1 日（JST）の支出上限 BUYER_DAILY_CAP_JPYC（既定 20）。署名する前に判定し、超えるなら支払わずに終了する
 * - 支出は署名した時点で計上する。送金されていないことが確実な応答（402 など）のときだけ戻す
 * - 当日の支出は買い手のローカル記録（log/buyer/buyer-YYYY-MM-DD.jsonl）から復元する
 */
import 'dotenv/config';
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { x402Client } from '@x402/core/client';
import { decodePaymentResponseHeader, wrapFetchWithPayment } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { createPublicClient, erc20Abi, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon, polygonAmoy } from 'viem/chains';
import { required } from '../../src/config.ts';
import { JPYC_ADDRESS, JPYC_EIP712, JPYC_NETWORKS, POLYGON_MAINNET, atomicToJpyc, jpycToAtomic, polygonscanTxUrl, type JpycNetwork } from '../../src/jpyc.ts';
import { jstDay, jstIso } from '../../src/log.ts';

const gatewayUrl = (process.env.GATEWAY_URL || 'http://localhost:8788').replace(/\/+$/, '');
const network = (process.env.JPYC_NETWORK || POLYGON_MAINNET) as JpycNetwork;
if (!JPYC_NETWORKS.includes(network)) throw new Error(`JPYC_NETWORK must be one of ${JPYC_NETWORKS.join(', ')}`);
const paths = (process.env.BUYER_PATHS || '/jin/series,/jin/movers').split(',').map((s) => s.trim()).filter(Boolean);
const capAtomic = jpycToAtomic(process.env.BUYER_DAILY_CAP_JPYC || '20');
const oncePerDay = process.env.BUYER_ONCE_PER_DAY !== 'false';
const expectedPayTo = process.env.BUYER_EXPECTED_PAY_TO?.toLowerCase();
const logDir = process.env.BUYER_LOG_DIR || join(process.env.LOG_DIR || 'log', 'buyer');

const account = privateKeyToAccount(required('BUYER_PRIVATE_KEY') as `0x${string}`);

interface BuyerRecord {
  ts: string;
  path: string;
  /** 署名して送った額（JPYC）。署名しなかったら 0 */
  spent_jpyc: string;
  status: 'ok' | 'http_error' | 'cap_exceeded' | 'error' | 'skipped_already_bought';
  http_status?: number;
  settle_tx?: string;
  polygonscan?: string;
  error?: string;
}

const today = jstDay();
const recordFile = join(logDir, `buyer-${today}.jsonl`);
const readRecords = (): BuyerRecord[] =>
  existsSync(recordFile) ? readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const record = (r: BuyerRecord) => {
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  appendFileSync(recordFile, JSON.stringify(r) + '\n');
  console.log(JSON.stringify(r));
};

const previous = readRecords();
let spentAtomic = previous.reduce((s, r) => s + jpycToAtomic(r.spent_jpyc || '0'), 0n);
console.log(`[buyer] ${account.address} day=${today} spent=${atomicToJpyc(spentAtomic)} / cap=${atomicToJpyc(capAtomic)} JPYC network=${network}`);

if (process.env.POLYGON_RPC_URL) {
  const pc = createPublicClient({ chain: network === POLYGON_MAINNET ? polygon : polygonAmoy, transport: http(process.env.POLYGON_RPC_URL) });
  const bal = await pc.readContract({ address: JPYC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
  console.log(`[buyer] JPYC balance ${atomicToJpyc(bal)}`);
}

// この実行で署名しようとしている額（上限判定に使う）
let pendingAtomic = 0n;

const client = new x402Client();
client.register(network, new ExactEvmScheme(account));
// JPYC は SDK の既定資産ではないので明示的に許可する。1 回の支払いも日次上限を超えない
client.setSpendControls({
  maxAmountPerPayment: false,
  allowedAssets: [{ network, asset: JPYC_ADDRESS, maxAmountPerPayment: capAtomic.toString() }],
});
// Polygon の JPYC（domain が正しいもの）以外の要求には署名しない
client.registerPolicy((_v, reqs) =>
  reqs.filter(
    (r) =>
      r.scheme === 'exact' &&
      r.network === network &&
      r.asset.toLowerCase() === JPYC_ADDRESS.toLowerCase() &&
      r.extra?.name === JPYC_EIP712.name &&
      r.extra?.version === JPYC_EIP712.version &&
      r.maxTimeoutSeconds <= 300 &&
      (!expectedPayTo || r.payTo.toLowerCase() === expectedPayTo),
  ),
);
client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
  const amount = BigInt(selectedRequirements.amount);
  if (spentAtomic + amount > capAtomic) {
    return { abort: true, reason: `daily cap: spent ${atomicToJpyc(spentAtomic)} + ${atomicToJpyc(amount)} > ${atomicToJpyc(capAtomic)} JPYC` };
  }
  pendingAtomic = amount;
});
client.onAfterPaymentCreation(async () => {
  // 署名した時点で計上する
  spentAtomic += pendingAtomic;
});

const fetchWithPayment = wrapFetchWithPayment(fetch, client);

for (const path of paths) {
  if (oncePerDay && previous.some((r) => r.path === path && r.status === 'ok')) {
    record({ ts: jstIso(), path, spent_jpyc: '0', status: 'skipped_already_bought' });
    continue;
  }
  pendingAtomic = 0n;
  const before = spentAtomic;
  try {
    const res = await fetchWithPayment(gatewayUrl + path);
    const pr = res.headers.get('payment-response');
    const settle = pr ? decodePaymentResponseHeader(pr) : undefined;
    const body = await res.text();
    // 送金されていないことが確実な応答（402 = 事前検査・verify・settle で拒否、verify の通信エラー）は計上を戻す。
    // settle の通信エラー（結果不明）や上流失敗（JPYC は送金済み）は計上したまま
    if (!settle?.success && (res.status === 402 || /"facilitator_verify_error"/.test(body))) spentAtomic = before;
    const spent = atomicToJpyc(spentAtomic - before);
    const rec: BuyerRecord = {
      ts: jstIso(),
      path,
      spent_jpyc: spent,
      status: res.ok ? 'ok' : 'http_error',
      http_status: res.status,
      settle_tx: settle?.transaction || undefined,
      polygonscan: settle?.transaction ? polygonscanTxUrl(network, settle.transaction) : undefined,
      error: res.ok ? undefined : body.slice(0, 300),
    };
    record(rec);
    if (res.ok) console.log(`[buyer] ${path} -> ${body.slice(0, 200)}${body.length > 200 ? '…' : ''}`);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    const spent = atomicToJpyc(spentAtomic - before);
    if (/daily cap/.test(msg)) {
      record({ ts: jstIso(), path, spent_jpyc: spent, status: 'cap_exceeded', error: msg });
      console.log('[buyer] daily cap reached; exiting without paying');
      process.exit(0);
    }
    record({ ts: jstIso(), path, spent_jpyc: spent, status: 'error', error: msg.slice(0, 300) });
  }
}
console.log(`[buyer] done. spent today ${atomicToJpyc(spentAtomic)} / ${atomicToJpyc(capAtomic)} JPYC`);
