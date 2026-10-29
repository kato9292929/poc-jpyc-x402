/**
 * 販売するエンドポイント（指示書 §1・指示書4 §3）。
 * 価格（JPYC）は環境変数で変えられる。上流原価（USD）は上流の価格で、上流の 402 がこれと違えば支払わない。
 *
 *   /jin/latest              JIN latest（無料）
 *   /jin/series              JIN series（$0.01）        2 JPYC
 *   /jin/movers              JIN movers（$0.02）        3 JPYC
 *   /osd/catalyst/{ticker}   OSD /api/catalyst/{ticker}（$0.001）  1 JPYC
 *
 * OSD は、未調査の銘柄（draft）には請求せずに無料で返す。上流が請求しなかったときは、買い手からも受け取らない。
 */
export interface Route {
  /** 表示用のパス（/osd/catalyst/{ticker} のようにパラメータを含む） */
  path: string;
  /** リクエストのパスがこのルートに当たれば、上流のパスを返す */
  match(reqPath: string): { upstreamPath: string; params: Record<string, string> } | undefined;
  /** 上流のベース URL を選ぶ */
  upstream: 'jin' | 'osd';
  /** 0 のときは 402 を返さず、上流（無料）をそのまま返す */
  priceJpyc: string;
  /** 上流原価（USD の10進文字列） */
  upstreamCostUsd: string;
  description: string;
  /** カタログ（Bazaar・OpenAPI）用：入力と出力の形 */
  discovery: {
    queryParams?: Record<string, { type: string; description: string; example?: string }>;
    pathParams?: Record<string, { type: string; description: string; example: string }>;
    outputExample: unknown;
    outputSchema: Record<string, unknown>;
  };
}

const exact = (path: string, upstreamPath: string) => (p: string) => (p === path ? { upstreamPath, params: {} } : undefined);

const jinCommon = {
  source: { type: 'string' },
  methodology: { type: 'string' },
  coverage_note: { type: 'string' },
};

export function loadRoutes(env: NodeJS.ProcessEnv = process.env): Route[] {
  return [
    {
      path: '/jin/latest',
      match: exact('/jin/latest', '/api/jin/latest'),
      upstream: 'jin',
      priceJpyc: '0',
      upstreamCostUsd: '0',
      description: 'JIN latest (free): latest Japan food inflation nowcast index.',
      discovery: { outputExample: { as_of: '2026-09-16', index: { excl_promo: 101.17, incl_promo: 100.63 } }, outputSchema: { type: 'object' } },
    },
    {
      path: '/jin/series',
      match: exact('/jin/series', '/api/jin/series'),
      upstream: 'jin',
      priceJpyc: priceEnv(env, 'PRICE_SERIES_JPYC', '2'),
      upstreamCostUsd: '0.01',
      description:
        'JIN daily food index series for Japan (excl/incl promo, matched SKU count). Single-store observation, not official CPI, not a forecast. Paid in JPYC.',
      discovery: {
        queryParams: {
          from: { type: 'string', description: 'First date to include (YYYY-MM-DD), optional', example: '2026-10-01' },
          to: { type: 'string', description: 'Last date to include (YYYY-MM-DD), optional', example: '2026-10-28' },
        },
        outputExample: { source: 'japan-inflation-nowcast', base_date: '2026-06-04', series: [{ date: '2026-06-04', excl: 100.0, incl: 100.0, m_excl: null, m_incl: null }] },
        outputSchema: {
          type: 'object',
          properties: {
            ...jinCommon,
            base_date: { type: 'string' },
            series: {
              type: 'array',
              items: { type: 'object', properties: { date: { type: 'string' }, excl: { type: 'number' }, incl: { type: 'number' }, m_excl: { type: ['number', 'null'] }, m_incl: { type: ['number', 'null'] } } },
            },
          },
        },
      },
    },
    {
      path: '/jin/movers',
      match: exact('/jin/movers', '/api/jin/movers'),
      upstream: 'jin',
      priceJpyc: priceEnv(env, 'PRICE_MOVERS_JPYC', '3'),
      upstreamCostUsd: '0.02',
      description: 'JIN daily movers: SKUs with the largest price change vs the base date, with promo tags. Not a forecast. Paid in JPYC.',
      discovery: {
        queryParams: { date: { type: 'string', description: 'Observation date (YYYY-MM-DD), optional; latest by default', example: '2026-09-16' } },
        outputExample: { as_of: '2026-09-16', movers: [{ category: '野菜・海藻', item: '国内産 きゅうり バラ 1本', pct: 62.7, promo_tag: false, note: 'vs base 2026-06-04' }] },
        outputSchema: {
          type: 'object',
          properties: {
            ...jinCommon,
            as_of: { type: 'string' },
            movers: {
              type: 'array',
              items: { type: 'object', properties: { category: { type: 'string' }, item: { type: 'string' }, pct: { type: 'number' }, promo_tag: { type: 'boolean' }, note: { type: 'string' } } },
            },
          },
        },
      },
    },
    {
      path: '/osd/catalyst/{ticker}',
      match: (p: string) => {
        const m = /^\/osd\/catalyst\/([A-Za-z0-9.\-]{1,16})$/.exec(p);
        return m ? { upstreamPath: `/api/catalyst/${encodeURIComponent(m[1])}`, params: { ticker: m[1] } } : undefined;
      },
      upstream: 'osd',
      priceJpyc: priceEnv(env, 'PRICE_OSD_JPYC', '1'),
      upstreamCostUsd: '0.001',
      description:
        'Onchain Stock Data: one Japanese listed company\'s catalyst (dated due date, success/fail conditions, source) plus latest disclosed financials. Paid in JPYC; companies not yet researched are returned free.',
      discovery: {
        pathParams: { ticker: { type: 'string', description: 'TSE securities code, e.g. 6339', example: '6339' } },
        outputExample: { ticker: '6339', name: '…', sector: '…', stage: 'active', catalyst: { due_date: '2026-12-31', success_condition: '…', fail_condition: '…', status: 'open' } },
        outputSchema: {
          type: 'object',
          properties: {
            ticker: { type: 'string' },
            name: { type: ['string', 'null'] },
            sector: { type: ['string', 'null'] },
            stage: { type: ['string', 'null'] },
            financials: { type: 'object' },
            catalyst: { type: 'object' },
            source: { type: ['string', 'null'] },
          },
        },
      },
    },
  ];
}

export function findRoute(routes: Route[], reqPath: string) {
  for (const r of routes) {
    const m = r.match(reqPath);
    if (m) return { route: r, ...m };
  }
  return undefined;
}

function priceEnv(env: NodeJS.ProcessEnv, name: string, dflt: string): string {
  const v = (env[name] ?? '').trim() || dflt;
  if (!/^\d+(\.\d{1,18})?$/.test(v) || Number(v) <= 0) throw new Error(`${name} must be a positive JPYC amount, got "${v}"`);
  return v;
}

/** USD の10進文字列を USDC の atomic（6桁）にする。上流の 402 と突き合わせるため。 */
export function usdToUsdcAtomic(usd: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(usd);
  if (!m) throw new Error(`invalid USD amount ${usd}`);
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
}
