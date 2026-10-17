// B の facilitator をローカルで起動する（動作確認用）。本番は vercel/facilitator
import 'dotenv/config';
import { createFacilitatorApp, loadFacilitatorServerConfig } from '../src/facilitator-server.ts';
const { app, relayer } = createFacilitatorApp(loadFacilitatorServerConfig());
const port = Number(process.env.FACILITATOR_PORT || 8790);
app.listen(port, () => console.log(`[facilitator] :${port} relayer=${relayer}`));
