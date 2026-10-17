// Vercel の関数（ゲートウェイ）。全パスを /api に rewrite し、express アプリに渡す
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createGatewayApp } from '../../src/gateway/app.ts';

// サーバーレスではリクエストごとにプロセスが止まる可能性があるので、ログの書き込みを待ってから応答する
const ready = createGatewayApp(undefined, { flushLogBeforeResponse: true });
ready.catch(() => undefined); // 失敗はリクエスト時に 500 で返す

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const { app } = await ready;
    (app as unknown as (req: IncomingMessage, res: ServerResponse) => void)(req, res);
  } catch (e) {
    console.error('[gateway] init failed', e);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'gateway_init_failed' }));
  }
}
