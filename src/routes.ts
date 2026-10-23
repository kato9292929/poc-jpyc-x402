/**
 * 販売するエンドポイント（指示書 §1）。JIN の 3 本だけ。OSD は対象外。
 * 価格（JPYC）は環境変数で変えられる。上流原価（USD）は JIN の価格で、上流の 402 がこれと違えば支払わない。
 */
export interface Route {
  path: string;
  /** JIN 上のパス */
  upstreamPath: string;
  /** 0 のときは 402 を返さず、上流（無料）をそのまま返す */
  priceJpyc: string;
  /** 上流原価（USD の10進文字列） */
  upstreamCostUsd: string;
  description: string;
}

export function loadRoutes(env: NodeJS.ProcessEnv = process.env): Route[] {
  return [
    {
      path: '/jin/latest',
      upstreamPath: '/api/jin/latest',
      priceJpyc: '0',
      upstreamCostUsd: '0',
      description: 'JIN latest（無料）',
    },
    {
      path: '/jin/series',
      upstreamPath: '/api/jin/series',
      priceJpyc: priceEnv(env, 'PRICE_SERIES_JPYC', '2'),
      upstreamCostUsd: '0.01',
      description: 'JIN daily food index series (excl/incl, matched SKU count). Single-store observation, not official CPI.',
    },
    {
      path: '/jin/movers',
      upstreamPath: '/api/jin/movers',
      priceJpyc: priceEnv(env, 'PRICE_MOVERS_JPYC', '3'),
      upstreamCostUsd: '0.02',
      description: 'JIN daily inflation nowcast movers: per-day mover SKUs vs base date, with promo tags.',
    },
  ];
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
