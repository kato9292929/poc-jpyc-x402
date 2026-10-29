// Vercel の関数（公開ゲートウェイ https://jpyc.x402jp.com）。全パスを /api に rewrite し、express アプリに渡す
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createGatewayApp } from '../../src/gateway/app.ts';

// Blob の OIDC トークンはリクエストの中でしか取れないので、最初のリクエストで初期化する（失敗したら次のリクエストでやり直す）。
// 関数はリクエストごとに止まる可能性があるので、ログの書き込みを待ってから応答する
let ready: ReturnType<typeof createGatewayApp> | undefined;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    ready ??= createGatewayApp(undefined, { flushLogBeforeResponse: true });
    const { app } = await ready;
    (app as unknown as (req: IncomingMessage, res: ServerResponse) => void)(req, res);
  } catch (e) {
    ready = undefined;
    console.error('[gateway] init failed', e);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    // 設定エラーの文言は変数名だけ（値は含まない）
    res.end(JSON.stringify({ error: 'gateway_init_failed', detail: String((e as Error)?.message ?? e).slice(0, 200) }));
  }
}
