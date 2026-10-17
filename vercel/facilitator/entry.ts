// Vercel の関数（B：自前ホストの facilitator）。CDP が通らなかったときだけデプロイする
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createFacilitatorApp, loadFacilitatorServerConfig } from '../../src/facilitator-server.ts';

let app: ReturnType<typeof createFacilitatorApp>['app'] | undefined;

export default function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    app ??= createFacilitatorApp(loadFacilitatorServerConfig()).app;
    (app as unknown as (req: IncomingMessage, res: ServerResponse) => void)(req, res);
  } catch (e) {
    console.error('[facilitator] init failed', e);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'facilitator_init_failed' }));
  }
}
