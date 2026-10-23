// B の facilitator（src/facilitator-server.ts）を起動する。CDP が通らなかったときの予備
import 'dotenv/config';
import { createFacilitatorApp, loadFacilitatorServerConfig } from '../src/facilitator-server.ts';
const { app, relayer } = createFacilitatorApp(loadFacilitatorServerConfig());
const port = Number(process.env.FACILITATOR_PORT || 8790);
app.listen(port, () => console.log(`[facilitator] :${port} relayer=${relayer}`));
