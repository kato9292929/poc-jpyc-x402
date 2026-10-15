/**
 * Phase 1 の完了条件の確認：settle の tx が成功し、JPYC が payTo に着金しているか。
 * 使い方: POLYGON_RPC_URL=... JPYC_PAY_TO=0x... npm run tx:check -- <txHash> [期待額 JPYC]
 */
import 'dotenv/config';
import { createPublicClient, getAddress, http, parseEventLogs, erc20Abi } from 'viem';
import { polygon, polygonAmoy } from 'viem/chains';
import { required } from '../src/config.ts';
import { JPYC_ADDRESS, POLYGON_MAINNET, atomicToJpyc, jpycToAtomic, polygonscanTxUrl, type JpycNetwork } from '../src/jpyc.ts';

const [tx, expected] = process.argv.slice(2);
if (!tx || !/^0x[0-9a-fA-F]{64}$/.test(tx)) throw new Error('usage: npm run tx:check -- <txHash> [expectedJpyc]');
const network = (process.env.JPYC_NETWORK || POLYGON_MAINNET) as JpycNetwork;
const payTo = getAddress(required('JPYC_PAY_TO'));
const pc = createPublicClient({ chain: network === POLYGON_MAINNET ? polygon : polygonAmoy, transport: http(required('POLYGON_RPC_URL')) });

const receipt = await pc.getTransactionReceipt({ hash: tx as `0x${string}` });
const transfers = parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: 'Transfer' }).filter(
  (l) => l.address.toLowerCase() === JPYC_ADDRESS.toLowerCase() && getAddress(l.args.to) === payTo,
);
const total = transfers.reduce((s, l) => s + l.args.value, 0n);
console.log(`tx ${polygonscanTxUrl(network, tx)}`);
console.log(`status=${receipt.status} block=${receipt.blockNumber} JPYC to ${payTo}: ${atomicToJpyc(total)}`);
for (const l of transfers) console.log(`  from ${l.args.from} value ${atomicToJpyc(l.args.value)} JPYC`);
const ok = receipt.status === 'success' && total > 0n && (!expected || total === jpycToAtomic(expected));
console.log(ok ? 'OK' : 'NG');
process.exit(ok ? 0 : 1);
