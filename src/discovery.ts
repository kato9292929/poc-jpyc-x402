/**
 * カタログに読ませる情報（指示書4 §2）。
 * - 402 の extensions.bazaar：入力（クエリ・パスのパラメータ）と出力の例・形（@x402/extensions の公式ヘルパーで作る）
 * - /openapi.json：x402scan が読む発見用の文書（x-payment-info、402 応答、パラメータ）
 *
 * x402scan の x-payment-info.price は USD 建てしか書けないので、JPYC の価格を JPYC_USD_RATE で換算した参考値を入れる
 * （実際に請求するのは 402 の accepts にある JPYC の額。仕様でも「実行時の 402 が優先」）。
 */
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
import type { Route } from './routes.ts';
import { NETWORK_SPECS } from './networks.ts';
import type { JpycNetwork } from './jpyc.ts';

export function bazaarExtension(route: Route, params: Record<string, string> = {}): Record<string, unknown> {
  const q = route.discovery.queryParams ?? {};
  const p = route.discovery.pathParams;
  const ext = declareDiscoveryExtension({
    input: Object.fromEntries(Object.entries(q).filter(([, v]) => v.example).map(([k, v]) => [k, v.example])),
    inputSchema: { properties: Object.fromEntries(Object.entries(q).map(([k, v]) => [k, { type: v.type, description: v.description }])) },
    ...(p
      ? {
          pathParams: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, params[k] ?? v.example])),
          pathParamsSchema: {
            properties: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { type: v.type, description: v.description }])),
            required: Object.keys(p),
          },
        }
      : {}),
    output: { example: route.discovery.outputExample, schema: route.discovery.outputSchema },
  } as never) as Record<string, any>;
  // HTTP のメソッドは実行時にサーバー拡張が補うが、ここでは拡張を通さないので自分で入れる
  if (ext.bazaar?.info?.input) ext.bazaar.info.input.method = 'GET';
  return ext;
}

export function openApiDocument(args: {
  publicBaseUrl: string;
  routes: Route[];
  networks: JpycNetwork[];
  jpycUsdRate: number;
  contactEmail?: string;
}) {
  const paths: Record<string, unknown> = {};
  const chains = args.networks.map((n) => NETWORK_SPECS[n].label).join(', ');
  for (const r of args.routes) {
    const params = [
      ...Object.entries(r.discovery.pathParams ?? {}).map(([name, v]) => ({ name, in: 'path', required: true, description: v.description, schema: { type: v.type }, example: v.example })),
      ...Object.entries(r.discovery.queryParams ?? {}).map(([name, v]) => ({ name, in: 'query', required: false, description: v.description, schema: { type: v.type }, ...(v.example ? { example: v.example } : {}) })),
    ];
    const paid = r.priceJpyc !== '0';
    const usd = (Number(r.priceJpyc) * args.jpycUsdRate).toFixed(4);
    paths[r.path] = {
      get: {
        summary: r.description.split('.')[0],
        description: paid ? `${r.description} Price: ${r.priceJpyc} JPYC per call (EIP-3009 on ${chains}).` : r.description,
        ...(params.length ? { parameters: params } : {}),
        ...(paid
          ? { 'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: usd }, protocols: [{ x402: {} }], 'x-jpyc-price': r.priceJpyc } }
          : {}),
        responses: {
          '200': { description: 'OK', content: { 'application/json': { schema: r.discovery.outputSchema, example: r.discovery.outputExample } } },
          ...(paid ? { '402': { description: 'Payment Required' } } : {}),
        },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'JPYC x402 data gateway',
      version: '1.0.0',
      description: 'Per-call data APIs paid in JPYC (Japanese yen stablecoin) over x402. Japan food inflation nowcast (JIN) and Japanese listed-company catalysts (OSD).',
      'x-guidance':
        'Call a paid endpoint without payment to receive HTTP 402 with accepts[] for each supported chain (JPYC, EIP-3009 exact scheme). Sign the transferWithAuthorization for one chain and retry with the PAYMENT-SIGNATURE header. You are only charged when data is delivered: if the upstream source fails, the signature is not settled.',
      ...(args.contactEmail ? { contact: { email: args.contactEmail } } : {}),
    },
    servers: [{ url: args.publicBaseUrl }],
    paths,
  };
}
