# poc-jpyc-x402

エージェントが **JPYC（円建てステーブルコイン、Polygon）** で x402 のデータ API を per-call で購入できることを、
Polygon mainnet 上の実決済で示し、決済ログを取る実証。

このリポジトリだけで完結する。JIN・OSD・poc-card-credits・poc-dual-checkout には手を入れない
（poc-card-credits は、ログの規則と上流購入の方式を合わせるために読んだだけ）。

```
買い手エージェント（JPYC 保有 / Polygon）            agents/buyer/index.ts
   │  GET /jin/series        ← 402（accepts: Polygon JPYC）
   │  再送 + PAYMENT-SIGNATURE（EIP-3009 署名）
   ▼
JPYC ゲートウェイ                                     src/gateway/
   │  事前検査（金額の完全一致・nonce 再送・有効期限）   src/payment.ts, src/nonce.ts
   │  facilitator /verify → /settle（JPYC の transferWithAuthorization）
   │  決済成功後、上流を購入
   ▼
JIN（jin.x402jp.com）を既存の x402（Solana / USDC）で購入    src/upstream.ts
   │
   ▼
レスポンスを買い手に返す + 決済ログを 1 行書く               src/log.ts, src/logstore/
```

## 決定事項

| 項目 | 決定 | 理由・根拠 |
|---|---|---|
| 対象チェーン | Polygon mainnet のみ（`eip155:137`） | 指示書 §0 |
| 販売エンドポイント・価格 | `/jin/latest`（0）・`/jin/series`（2 JPYC）・`/jin/movers`（3 JPYC） | 初期値のまま。`PRICE_SERIES_JPYC` / `PRICE_MOVERS_JPYC` で変更可 |
| JPYC の EIP-712 domain | `name: "JPY Coin"` / `version: "1"` | mainnet・Amoy の両方で、この domain の署名をコントラクトが受け入れることを確認（`npm run jpyc:domain-check`）。コントラクトに `version()` は無い |
| facilitator | **A（CDP Facilitator）を採用** | `/supported` に `eip155:137` の `exact` があり、JPYC で verify / settle が 2 件とも 1 回で通った（下表）。B は使っていない |
| B（自前ホスト） | 予備として実装のみ（`src/facilitator-server.ts`、`npm run facilitator:serve`） | x402 の参照実装（`@x402/evm`）を使用。CDP が使えなくなったときに `FACILITATOR_URL` を向け替える。relayer ウォレット `0x41ff0e098Cd675ACe5F1BdCf58042cDE9e802BBd`（Polygon、POL 0.5 入金済み・未使用） |
| Phase 0（Amoy） | **実施しない** | 指示書2の決定。mainnet を少額で行った |
| 実行場所 | ゲートウェイ・買い手ともに作業用コンテナ内（`localhost`） | 指示書2の決定。Vercel へのデプロイは行っていない |
| 定期実行 | GitHub Actions の cron（毎日 06:30 JST、1 日 10 JPYC・30 日間） | 指示書3の決定。下の「定期実行」を参照 |

### Phase 1 の結果（2026-10-18、Polygon mainnet、facilitator = CDP）

| | `/jin/series` | `/jin/movers` |
|---|---|---|
| settle tx（Polygon） | [0x7699b2e4…57da](https://polygonscan.com/tx/0x7699b2e469efbd6c2804974bfcac632e4ddb4e6827263bbf113fbf44f86757da) | [0x15e175b5…6ae1](https://polygonscan.com/tx/0x15e175b5f09357cacabeacd4ef98966f2406d93703d93f2316615a2311c46ae1) |
| JPYC の着金 | payTo に 2 JPYC（`npm run tx:check` で確認） | payTo に 3 JPYC（同） |
| 上流購入 tx（Solana） | [4Zpoi29V…EYaY](https://solscan.io/tx/4Zpoi29VQXw6yCFcYnuh24oWYxoNbUgLtYNJD96yZRtsRvHdQ6cN8uHxNEvYCi5bHVhx6oqjysnyAUNFRREpEYaY) | [3rfdR3pe…TirP](https://solscan.io/tx/3rfdR3peDQsEaR6wm2r4txZDGnhJx1BcGSgppjtZqRV8b2WyB1q7yif3F1AkDPpnFhMXbbrPp6p4UQ9sCtB9TirP) |
| settle_ms（verify 開始〜settle 完了） | 2,532 | 1,995 |
| 買い手に返ったデータ | JIN series（200） | JIN movers（200） |
| 決済ログ | `status=ok` 1 行 | `status=ok` 1 行 |

アドレス：買い手 `0x91Cb1df115c14298BE06Cd80B7D2D41ac5E659cA`、受取（payTo）`0xb04c275C85ddb34CdF1A6f48A4A749f969377a6e`、
上流購入（Solana）`3EX6L11khPXTRC6wdRbrEibHi8tH7TZ1PRTYSX7R218f`（poc-card-credits のゲートウェイ鍵とは別に新規作成）。

### 1 件あたりの実費

| | `/jin/series` | `/jin/movers` |
|---|---|---|
| 受領（JPYC） | 2 JPYC | 3 JPYC |
| 上流原価（USDC、Solana） | $0.01 | $0.02 |
| Solana の手数料 | 0（10,001 lamports は JIN 側の feePayer `CjNFTj…eKww` が負担） | 同左 |
| Polygon のガス代 | 0（CDP の送信アドレスが負担。参考：0.0517 POL / 0.0445 POL） | 同左 |
| facilitator 手数料 | CDP からの請求額は未確認（このコンテナからは請求情報を見られない） | 同左 |

買い手は POL を持たずに支払えた（EIP-3009 の署名だけ）。上流購入用ウォレットの SOL（0.005）は減っていない。

## 起動手順（コンテナ内で動かす）

Node.js 22 以上。秘密鍵・API キーは gitignore 済みの env ファイルにだけ置き、役割ごとにファイルを分ける
（ゲートウェイに買い手の鍵を置かないため。ゲートウェイは `BUYER_PRIVATE_KEY` があると起動しない）。

| ファイル | 中身 |
|---|---|
| `.env.gateway` | `FACILITATOR_URL`・`CDP_API_KEY_ID`・`CDP_API_KEY_SECRET`・`JPYC_PAY_TO`・`UPSTREAM_SOLANA_PRIVATE_KEY`・`POLYGON_RPC_URL`・`NODE_ENV=development`・`LOG_SINK=file` |
| `.env.buyer` | `BUYER_PRIVATE_KEY`・`GATEWAY_URL`・`BUYER_DAILY_CAP_JPYC=20`・`BUYER_ONCE_PER_DAY=1`・`BUYER_EXPECTED_PAY_TO` |
| `.env.facilitator`（B のときだけ） | `RELAYER_PRIVATE_KEY`・`FACILITATOR_AUTH_TOKEN`・`FACILITATOR_ALLOWED_PAY_TO`・`POLYGON_RPC_URL` |

```sh
npm install
npm test && npm run typecheck

npm run wallet:new -- --solana   # 上流購入用（poc-card-credits の鍵とは別）
npm run wallet:new -- --evm      # 買い手用・受取用・relayer 用

DOTENV_CONFIG_PATH=.env.gateway npm run facilitator:check   # CDP が eip155:137 の exact に対応しているか
DOTENV_CONFIG_PATH=.env.gateway npm run gateway             # 起動時にも /supported を確かめる
DOTENV_CONFIG_PATH=.env.buyer BUYER_PATHS=/jin/series npm run buyer
DOTENV_CONFIG_PATH=.env.gateway npm run tx:check -- <settle tx> 2
npm run balances -- --polygon <買い手>,<payTo> --solana <上流購入用>
```

B に切り替えるとき：`DOTENV_CONFIG_PATH=.env.facilitator npm run facilitator:serve` で起動し、`.env.gateway` の
`FACILITATOR_URL=http://localhost:8790`・`FACILITATOR_KIND=self`・`FACILITATOR_AUTH_TOKEN`（facilitator と同じ値）に変える。
B は relayer のガスを守るため、JPYC・`FACILITATOR_ALLOWED_PAY_TO`・`FACILITATOR_MAX_JPYC` 以下の要求しか受け付けない。

買い手スクリプト：
- 1 回の実行で `BUYER_PATHS`（既定 `/jin/series,/jin/movers`）を 1 回ずつ買って終わる
- `BUYER_DAILY_CAP_JPYC`（既定 20）：JST の 1 日の支出上限。署名する前に判定し、超えるなら支払わずに止まる
- `BUYER_ONCE_PER_DAY`（既定 1）：同じ JST 日に購入済みのパスは買わない（パスごとのロックで二重起動も防ぐ）
- 支出は署名した時点で計上し、送金されていないことが確実な応答（402 など）のときだけ戻す。記録は `log/buyer/YYYY-MM-DD.jsonl`

## 定期実行（GitHub Actions、指示書3）

`.github/workflows/daily-buy.yml`。毎日 06:30 JST に 1 回、ジョブ内でゲートウェイを localhost に起動し、買い手がそこから買う。

| 項目 | 設定 |
|---|---|
| 1 日の購入 | `/jin/series` 2 回 + `/jin/movers` 2 回（交互、3 秒間隔）= 10 JPYC、上流原価 0.06 USDC（30 日で 300 JPYC / 1.80 USDC） |
| 上限 | `BUYER_DAILY_CAP_JPYC=10`、1 日 1 回の制限（`BUYER_ONCE_PER_DAY`）は外す |
| 期間 | 2026-10-25〜2026-11-23（30 日、`RUN_START_JST` / `RUN_UNTIL_JST`。リポジトリ変数で上書き可）。期間外のジョブは何も支払わずに終わる |
| 失敗 | verify・settle の失敗、上流の失敗（`upstream_failed`）はログに残して次へ。同じ日の失敗が 5 件を超えたら、その日の残りは支払わない |
| 残高 | 始める前に、その日の計画分の JPYC（買い手）と USDC（上流購入用）があるかを確かめ、足りなければ支払わない |
| 鍵 | GitHub Secrets：`GATEWAY_ENV`（CDP キー・上流購入用の鍵）はゲートウェイの手順だけ、`BUYER_ENV`（買い手の鍵）は買い手の手順だけに渡す |
| 記録 | 決済ログ `log/YYYY-MM-DD.jsonl`、買い手の記録 `log/buyer/YYYY-MM-DD.jsonl`、集計 `summary.json` を毎日コミットする |

`summary.json`：累計件数・status 別件数・成功率、settle 時間の中央値と最大、累計 JPYC（受領）、累計上流 USDC、
CDP が負担したガス代の合計（settle tx の receipt から計算）。ローカルで作り直すときは `RUN_START_JST=... npx tsx scripts/summary.ts`。

失敗は、お金がどこまで動いたかで 4 つの型に分けて数える（`src/failures.ts`、`summary.json` の `failures`）：

| 型 | お金の動き |
|---|---|
| JPYC の verify / settle が失敗 | JPYC 受領なし・上流 USDC 動かない |
| 上流が未払いの段階で失敗 | JPYC 受領済み・上流 USDC 動かない |
| 上流が支払い受領後に失敗（402 など） | JPYC 受領済み・上流 USDC 動かない（上流の tx なし） |
| 上流は支払い済み、データを渡せず | JPYC 受領済み・上流 USDC 支払い済み（回収できない原価） |

週次レポート（Markdown）：`npm run report:weekly -- --from 2026-10-25 --to 2026-10-31 [--out reports/weekly-2026-10-25.md]`

## 決済ログ

poc-card-credits と同じ規則：1 決済 1 行の JSONL、日付の区切りは JST（`log/YYYY-MM-DD.jsonl`）、
本番は Vercel Blob、`LOG_SINK=file` は `NODE_ENV=development` のときだけ。402 を返しただけのリクエスト（未払い）や
無料の `/jin/latest` は決済ではないので書かない。支払い（`PAYMENT-SIGNATURE`）を伴ったリクエストは結果によらず必ず 1 行書く。

| 項目 | 内容 |
|---|---|
| `ts` | ISO8601（JST、`+09:00`） |
| `endpoint` | `/jin/series` など |
| `price_jpyc` | 402 で提示した価格 |
| `payer` | 買い手アドレス（署名の `from`） |
| `pay_to` | 受取アドレス |
| `network` | `eip155:137` |
| `facilitator` | `cdp` / `self` |
| `settle_tx` | Polygon の tx hash（未 settle は `none`） |
| `settle_ms` | verify 開始から settle 完了までのミリ秒（verify まで進まなかった・verify で落ちたら 0） |
| `upstream_cost_usd` | 上流原価（購入できなかったら 0） |
| `upstream_tx` | 上流購入の Solana tx（購入していなければ `none`、払ったが読めなければ `unknown`） |
| `status` | `ok` / `verify_failed` / `settle_failed` / `upstream_failed` |
| `error` | 失敗理由（失敗時のみ） |

`verify_failed` には、facilitator の verify 失敗に加えて、ゲートウェイ側の事前検査で弾いたもの（`error` が `precheck: ...`）も入る。

```sh
npm run logs:summary                 # 日付ごとの status 件数・受領額、upstream_failed（手動返金の対象）の一覧
npm run logs:summary -- 2026-10-16
```

## 署名まわり（§7）

- `nonce`：32 バイトのランダム値（`@x402/evm` の買い手実装が `crypto.getRandomValues` で作る）。ゲートウェイは形式（`0x` + 64 桁）を確かめる
- `validBefore`：402 の `maxTimeoutSeconds` を 300 にしているので、署名時刻から 5 分以内。ゲートウェイは「現在 + 5 分（時計のずれ 30 秒まで許容）」より先なら弾く
- `value`：402 で提示した金額（atomic の文字列）と完全一致しなければ verify に進まない。`accepted` の各項目（ネットワーク・資産・payTo・金額）も提示内容と照合する
- 同じ nonce の再送：facilitator に投げる前に弾く（ゲートウェイのメモリに validBefore + 1 分まで保持）。再起動で消えるが、その場合もチェーン側の `authorizationState` が二重使用を防ぐ
- 金額の変換は `src/jpyc.ts` の `jpycToAtomic` / `atomicToJpyc` だけで行う（decimals = 18）

## 既知の制約

- **上流の購入に失敗した場合は手動返金。** JPYC は受領済みなので `status=upstream_failed` で記録し、買い手には 502（本文に `settle_tx` と `refund: "manual"`）を返す。返金は自動化していない。件数と対象は `npm run logs:summary` で数える
- **Polygon のみ。** 他チェーン・OSD のエンドポイントは対象外
- **常駐していない。** 今回はコンテナ内で起動して実証した。外から呼べる公開 URL・定期実行は未設定
- settle の通信がタイムアウトした場合は結果不明（facilitator 側では完了している可能性がある）。`settle_failed` で記録されるので、Polygonscan で買い手アドレスの JPYC の動きを確認する
- nonce の再送防止はプロセス内メモリ。ゲートウェイを複数台で動かす場合は台をまたいで共有されない（チェーン側の二重使用防止が最後の砦）
- 上流（JIN）の 402 の価格・資産（Solana mainnet の USDC）が `src/routes.ts` の原価と違う場合は、上流に支払わず `upstream_failed` になる

## やらないこと（§8）

JPYC → USDC などの交換・JPYC の償還、第三者の JPYC の預かり・代理支払い、poc-dual-checkout の集計への組み込み、Polygon 以外のチェーン、OSD のエンドポイント。

## 構成

```
src/jpyc.ts             JPYC の固定値と金額変換（唯一の変換箇所）
src/routes.ts           販売エンドポイントと価格・上流原価
src/payment.ts          402 の要求の組み立て、verify 前の事前検査
src/nonce.ts            nonce の再送防止
src/facilitator.ts      facilitator クライアント（CDP の認証ヘッダ対応）
src/upstream.ts         JIN を x402（Solana / USDC）で購入
src/gateway/handler.ts  1 リクエストの処理（402 → verify → settle → 上流 → ログ）
src/gateway/server.ts   express の起動
src/log.ts, src/logstore/  決済ログ（JSONL、JST、Vercel Blob / ローカルファイル）
src/buyer.ts            買い手エージェント（@x402/fetch + viem、日次上限・1日1回）。CLI は agents/buyer/index.ts
src/facilitator-server.ts  B：自前ホストの facilitator（予備、未使用）
scripts/                facilitator・domain・settle tx・残高の確認、ログ集計、鍵の作成
```
