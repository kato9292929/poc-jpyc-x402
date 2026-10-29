/**
 * 買い手エージェント（指示書 §4 Phase 1・2）。JPYC（Polygon）でゲートウェイの /jin/series・/jin/movers を買う。
 * 1 回の実行で paths を 1 回ずつ購入して終わる。CLI は agents/buyer/index.ts。
 *
 * - 1 日（JST）の支出上限 dailyCapJpyc。署名する前に判定し、超えるなら支払わずに終了する
 * - 支出は署名した時点で計上する。送金されていないことが確実な応答（402 など）のときだけ戻す
 * - 当日の支出は買い手の記録（RecordStore）から復元する
 * - oncePerDay：同じ JST 日に購入済み（または購入中）のパスは買わない。二重起動に備えてパスごとにロックを取る
 * - 定期実行（指示書3）向け：
 *   - plan：同じパスを複数回買う順番（BUYER_PLAN=/jin/series:20,/jin/movers:20 → 交互に並べる）、intervalMs で間隔を空ける
 *   - runUntilJst：この日（JST）を過ぎたら支払わずに終了する
 *   - maxFailuresPerDay：同じ日の失敗（http_error / error）がこの件数を超えたら、その日の残りは支払わずに終了する
 *   - checkFunds：始める前に、その日の残りの計画分の JPYC・上流 USDC が足りるかを確かめ、足りなければ支払わずに終了する
 */
import { x402Client } from '@x402/core/client';
import { decodePaymentResponseHeader, wrapFetchWithPayment } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { createPublicClient, erc20Abi, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { NETWORK_SPECS } from './networks.ts';
import { JPYC_ADDRESS, JPYC_EIP712, JPYC_NETWORKS, POLYGON_MAINNET, atomicToJpyc, jpycToAtomic, polygonscanTxUrl, type JpycNetwork } from './jpyc.ts';
import { jstDay, jstIso } from './log.ts';
import { parseLines } from './logstore/types.ts';
import { usdToUsdcAtomic } from './routes.ts';

export interface BuyerRecord {
  ts: string;
  path: string;
  /** 署名して送った額（JPYC）。署名しなかったら 0 */
  spent_jpyc: string;
  status: 'ok' | 'http_error' | 'cap_exceeded' | 'error' | 'skipped_already_bought' | 'stopped';
  http_status?: number;
  settle_tx?: string;
  polygonscan?: string;
  error?: string;
  /** ゲートウェイが X-PAYMENT-LOG で返した決済ログの 1 行 */
  gateway_log?: Record<string, unknown>;
}

/** 買い手の記録の置き場（JST の日付ごとの JSONL と、パスごとのロック） */
export interface RecordStore {
  append(day: string, line: string): Promise<void>;
  read(day: string): Promise<string | null>;
  /** 取れたら true。既にあれば false */
  tryLock(key: string): Promise<boolean>;
  unlock(key: string): Promise<void>;
}

export interface BuyerOptions {
  privateKey: `0x${string}`;
  gatewayUrl: string;
  network?: JpycNetwork;
  paths?: string[];
  /** 買う順番（同じパスの繰り返し可）。指定時は paths より優先 */
  plan?: string[];
  /** 1 回ごとの間隔（ミリ秒） */
  intervalMs?: number;
  /** 'YYYY-MM-DD'（JST）。この日を過ぎたら支払わない */
  runUntilJst?: string;
  /** 同じ日の失敗がこの件数を超えたら止める */
  maxFailuresPerDay?: number;
  /** 残りの計画に要る JPYC（atomic）と上流 USDC（atomic, 6 桁）を渡す。足りなければ理由を返す */
  checkFunds?: (needJpycAtomic: bigint, needUsdcAtomic: bigint, buyerAddress: string) => Promise<string | undefined>;
  /** パスごとの価格（JPYC）と上流原価（USD）。checkFunds の必要額の計算に使う */
  costs?: Record<string, { priceJpyc: string; upstreamCostUsd: string }>;
  dailyCapJpyc?: string;
  oncePerDay?: boolean;
  expectedPayTo?: string;
  polygonRpcUrl?: string;
  store: RecordStore;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
  now?: () => Date;
}

export interface BuyerRunResult {
  address: string;
  day: string;
  spentBeforeJpyc: string;
  spentAfterJpyc: string;
  capJpyc: string;
  balanceJpyc?: string;
  records: BuyerRecord[];
  /** 途中で止めた理由（止めなければ undefined） */
  stopReason?: string;
  /** 本文の先頭（確認用） */
  bodies: Record<string, string>;
}

/** "1" / "true" / "0" / "false" を真偽値に */
export function envFlag(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  if (/^(1|true|yes)$/i.test(v)) return true;
  if (/^(0|false|no)$/i.test(v)) return false;
  throw new Error(`invalid boolean "${v}"`);
}

/** "/jin/series:20,/jin/movers:20" → 交互に並べた 40 件の配列 */
export function parsePlan(spec: string): string[] {
  const parts = spec.split(',').map((s) => s.trim()).filter(Boolean).map((p) => {
    const m = /^(\/[^:]+)(?::(\d+))?$/.exec(p);
    if (!m) throw new Error(`invalid BUYER_PLAN entry "${p}"`);
    return { path: m[1], n: Number(m[2] ?? 1) };
  });
  const out: string[] = [];
  for (let i = 0; parts.some((p) => p.n > i); i++) for (const p of parts) if (p.n > i) out.push(p.path);
  return out;
}

export function buyerOptionsFromEnv(env: NodeJS.ProcessEnv, store: RecordStore): BuyerOptions {
  const pk = env.BUYER_PRIVATE_KEY;
  if (!pk) throw new Error('missing BUYER_PRIVATE_KEY');
  const network = (env.JPYC_NETWORK || POLYGON_MAINNET) as JpycNetwork;
  if (!JPYC_NETWORKS.includes(network)) throw new Error(`JPYC_NETWORK must be one of ${JPYC_NETWORKS.join(', ')}`);
  return {
    privateKey: pk as `0x${string}`,
    gatewayUrl: env.GATEWAY_URL || 'http://localhost:8788',
    network,
    paths: (env.BUYER_PATHS || '/jin/series,/jin/movers').split(',').map((s) => s.trim()).filter(Boolean),
    dailyCapJpyc: env.BUYER_DAILY_CAP_JPYC || '20',
    oncePerDay: envFlag(env.BUYER_ONCE_PER_DAY, true),
    plan: env.BUYER_PLAN ? parsePlan(env.BUYER_PLAN) : undefined,
    intervalMs: env.BUYER_INTERVAL_MS ? Number(env.BUYER_INTERVAL_MS) : undefined,
    runUntilJst: env.RUN_UNTIL_JST || undefined,
    maxFailuresPerDay: env.BUYER_MAX_FAILURES_PER_DAY ? Number(env.BUYER_MAX_FAILURES_PER_DAY) : undefined,
    expectedPayTo: env.BUYER_EXPECTED_PAY_TO || undefined,
    polygonRpcUrl: env.POLYGON_RPC_URL || undefined,
    store,
  };
}

export async function runBuyer(o: BuyerOptions): Promise<BuyerRunResult> {
  const log = o.log ?? ((m: string) => console.log(m));
  const now = o.now ?? (() => new Date());
  const network = o.network ?? POLYGON_MAINNET;
  const gatewayUrl = o.gatewayUrl.replace(/\/+$/, '');
  const paths = o.plan ?? o.paths ?? ['/jin/series', '/jin/movers'];
  const capAtomic = jpycToAtomic(o.dailyCapJpyc ?? '20');
  const oncePerDay = o.oncePerDay ?? true;
  const expectedPayTo = o.expectedPayTo?.toLowerCase();
  const account = privateKeyToAccount(o.privateKey);
  const day = jstDay(now());

  const previous = parseLines(await o.store.read(day)) as BuyerRecord[];
  let spentAtomic = previous.reduce((s, r) => s + jpycToAtomic(r.spent_jpyc || '0'), 0n);
  const result: BuyerRunResult = {
    address: account.address,
    day,
    spentBeforeJpyc: atomicToJpyc(spentAtomic),
    spentAfterJpyc: '',
    capJpyc: atomicToJpyc(capAtomic),
    records: [],
    bodies: {},
  };
  log(`[buyer] ${account.address} day=${day} spent=${result.spentBeforeJpyc} / cap=${result.capJpyc} JPYC network=${network}`);

  if (o.polygonRpcUrl) {
    const pc = createPublicClient({ chain: NETWORK_SPECS[network].chain, transport: http(o.polygonRpcUrl) });
    const bal = await pc.readContract({ address: JPYC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
    result.balanceJpyc = atomicToJpyc(bal);
    log(`[buyer] JPYC balance ${result.balanceJpyc}`);
  }

  const record = async (r: BuyerRecord) => {
    result.records.push(r);
    await o.store.append(day, JSON.stringify(r));
    log(JSON.stringify(r));
  };
  const stop = async (reason: string) => {
    result.stopReason = reason;
    await record({ ts: jstIso(now()), path: '-', spent_jpyc: '0', status: 'stopped', error: reason });
    log(`[buyer] stopped without paying: ${reason}`);
    result.spentAfterJpyc = atomicToJpyc(spentAtomic);
    return result;
  };
  const isFailure = (r: BuyerRecord) => r.status === 'http_error' || r.status === 'error';
  let failures = previous.filter(isFailure).length;
  const maxFailures = o.maxFailuresPerDay ?? Infinity;

  // 期間（RUN_UNTIL_JST）を過ぎていたら支払わない
  if (o.runUntilJst) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.runUntilJst)) throw new Error(`invalid RUN_UNTIL_JST ${o.runUntilJst}`);
    if (day > o.runUntilJst) return stop(`run period ended (RUN_UNTIL_JST=${o.runUntilJst}, today=${day})`);
  }
  if (failures > maxFailures) return stop(`failures today ${failures} > ${maxFailures}`);

  // 残りの計画分の JPYC・上流 USDC が足りなければ支払わない
  if (o.checkFunds) {
    let needJpyc = 0n;
    let needUsdc = 0n;
    for (const p of paths) {
      const c = o.costs?.[p];
      if (!c) continue;
      needJpyc += jpycToAtomic(c.priceJpyc);
      needUsdc += usdToUsdcAtomic(c.upstreamCostUsd);
    }
    const capLeft = capAtomic - spentAtomic;
    if (needJpyc > capLeft) needJpyc = capLeft > 0n ? capLeft : 0n;
    const short = await o.checkFunds(needJpyc, needUsdc, account.address);
    if (short) return stop(short);
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
    spentAtomic += pendingAtomic;
  });
  const fetchWithPayment = wrapFetchWithPayment(o.fetch ?? fetch, client);

  for (const [i, path] of paths.entries()) {
    const lockKey = `${day}${path}`;
    if (oncePerDay) {
      const bought = previous.some((r) => r.path === path && r.status === 'ok');
      if (bought || !(await o.store.tryLock(lockKey))) {
        await record({ ts: jstIso(now()), path, spent_jpyc: '0', status: 'skipped_already_bought' });
        continue;
      }
    }
    pendingAtomic = 0n;
    const before = spentAtomic;
    let rec: BuyerRecord;
    try {
      const res = await fetchWithPayment(gatewayUrl + path);
      const pr = res.headers.get('payment-response');
      const settle = pr ? decodePaymentResponseHeader(pr) : undefined;
      const body = await res.text();
      // 送金されていないことが確実な応答（402 = 事前検査・verify・settle で拒否、verify の通信エラー）は計上を戻す。
      // settle の通信エラー（結果不明）や上流失敗（JPYC は送金済み）は計上したまま
      // 送金されていないことが確実な応答は計上を戻す：402（事前検査・verify・settle で拒否）、
      // ゲートウェイが charged:false / X-CHARGED: false を返したもの（上流の失敗・無料の応答。settle していない）
      const notCharged = res.headers.get('x-charged') === 'false' || /"charged":false/.test(body) || /"facilitator_verify_error"/.test(body);
      if (!settle?.success && (res.status === 402 || notCharged)) spentAtomic = before;
      // ゲートウェイの決済ログ 1 行（X-PAYMENT-LOG）。定期実行はこれを log/ に残す
      const xlog = res.headers.get('x-payment-log');
      let gatewayLog: Record<string, unknown> | undefined;
      if (xlog) {
        try {
          gatewayLog = JSON.parse(Buffer.from(xlog, 'base64').toString('utf8'));
        } catch {
          gatewayLog = undefined;
        }
      }
      rec = {
        ts: jstIso(now()),
        path,
        spent_jpyc: atomicToJpyc(spentAtomic - before),
        status: res.ok ? 'ok' : 'http_error',
        http_status: res.status,
        settle_tx: settle?.transaction || undefined,
        polygonscan: settle?.transaction ? polygonscanTxUrl(network, settle.transaction) : undefined,
        error: res.ok ? undefined : body.slice(0, 300),
        gateway_log: gatewayLog,
      };
      if (res.ok) result.bodies[path] = body.slice(0, 300);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      rec = {
        ts: jstIso(now()),
        path,
        spent_jpyc: atomicToJpyc(spentAtomic - before),
        status: /daily cap/.test(msg) ? 'cap_exceeded' : 'error',
        error: msg.slice(0, 300),
      };
    }
    await record(rec);
    if (isFailure(rec)) failures++;
    // 何も支払わずに失敗したときだけロックを外す（その日のうちに再実行できる）
    if (oncePerDay && rec.status !== 'ok' && rec.spent_jpyc === '0') await o.store.unlock(lockKey);
    if (rec.status === 'cap_exceeded') {
      log('[buyer] daily cap reached; stopping without paying');
      break;
    }
    if (failures > maxFailures) {
      await stop(`failures today ${failures} > ${maxFailures}`);
      break;
    }
    if (o.intervalMs && i < paths.length - 1) await new Promise((r) => setTimeout(r, o.intervalMs));
  }
  result.spentAfterJpyc = atomicToJpyc(spentAtomic);
  log(`[buyer] done. spent today ${result.spentAfterJpyc} / ${result.capJpyc} JPYC`);
  return result;
}
