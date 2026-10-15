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
| 対象チェーン | Polygon のみ（`eip155:137`、Phase 0 は `eip155:80002`） | 指示書 §0。Ethereum・Avalanche・Kaia は対象外 |
| 販売エンドポイント | `/jin/latest`（0）・`/jin/series`（2 JPYC）・`/jin/movers`（3 JPYC） | 指示書 §1 の初期値。`PRICE_SERIES_JPYC` / `PRICE_MOVERS_JPYC` で変更可 |
| JPYC の EIP-712 domain | `name: "JPY Coin"` / `version: "1"` | 2026-10-15 に mainnet・Amoy の両方で、この domain の署名をコントラクトが受け入れることを確認した（`npm run jpyc:domain-check`。`"2"` や `"JPYC"` では `EIP3009: invalid signature` で revert）。コントラクトには `version()` が無いので、facilitator 側は 402 の `extra` の値を使う |
| facilitator | **未確定：A（CDP）から試す** | 下の「facilitator の選定」を参照。実機での確認後にこの欄を更新する |
| Phase 0（Amoy） | **未確定** | 下の「Phase 0」を参照 |
| Phase 1 の settle tx | **未実施**（記入欄：`https://polygonscan.com/tx/<hash>`） | 買い手ウォレットへの JPYC 入金後に実施する |

### facilitator の選定（§3）

コードは `FACILITATOR_URL` だけで A・B を切り替えられる（どちらも x402 v2 の `/verify`・`/settle`・`/supported`）。
決済ログの `facilitator` 列は URL から自動で `cdp` / `self` になる（`FACILITATOR_KIND` で上書き可）。

- **A（CDP Facilitator）**：この作業環境からは CDP の API キーが無いため `/supported` が `401 Unauthorized` で、
  `eip155:137` + `exact` の掲載を確かめられていない。API キーを入れて次を実行する：
  ```sh
  FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402 CDP_API_KEY_ID=... CDP_API_KEY_SECRET=... npm run facilitator:check
  ```
  `OK` が出たら、Phase 1 の手順で JPYC の verify / settle を 1 回通す。落ちたらエラー内容（決済ログの `error` 列にも出る）をここに書いて B に切り替える。
- **B（自前ホスト）**：第一候補は `github.com/Mameta29/jpyc-x402-facilitator`。この作業環境からはリポジトリを読めなかったので、
  中身は未確認。relayer ウォレットに POL を入れてガスを負担する。
  なお、x402 の参照実装（`@x402/evm` の facilitator）を Polygon の RPC につないだだけでも、このゲートウェイの 402 に対して
  作った JPYC の支払いが署名・domain・金額の検査を通り、残高チェックまで進むことを確認した
  （`npm run verify:simulate`：使い捨ての鍵なので結果は `invalid_exact_evm_insufficient_balance` になる。mainnet・Amoy とも同じ）。
  Mameta29 版が使えない場合の代わりにできる。

### Phase 0（Amoy）

- JPYC のコントラクトは Amoy にも同じアドレスで存在する（`name()` = `JPY Coin`、`decimals()` = 18、発行量あり）。
- テスト用 JPYC を入手する手段（faucet 等）は、この作業環境からは確認できていない。
  入手できたら `JPYC_NETWORK=eip155:80002` でゲートウェイと買い手を起動し、402 → 署名 → verify → settle → 200 を一周させる。
- 入手できない場合は Phase 0 を飛ばし、Phase 1 を少額（1〜3 JPYC）で行う。どちらにしたかをこの欄に書く。

## 起動手順

Node.js 22 以上。

```sh
npm install
cp .env.example .env   # 値を入れる（.env はコミットしない）
npm test               # ユニットテスト（ネットワーク不要）
npm run typecheck
```

### 鍵の用意

```sh
npm run wallet:new -- --solana   # 上流購入用 → UPSTREAM_SOLANA_PRIVATE_KEY（Solana mainnet の USDC を少額入れる）
npm run wallet:new -- --evm      # 買い手用 → BUYER_PRIVATE_KEY（Polygon の JPYC を少額入れる）
```

- 上流購入用の鍵は poc-card-credits のゲートウェイ鍵と**別**にする（同じ環境に `GATEWAY_WALLET_SECRET` があり同じ値なら起動しない）
- `JPYC_PAY_TO`（受取、x402 Inc. 管理）・上流購入用・買い手の 3 つは別のウォレットにする
- `BUYER_PRIVATE_KEY` はゲートウェイの環境に置かない（置くとゲートウェイは起動しない）

### ゲートウェイ

```sh
# 本番：ログは Vercel Blob（BLOB_READ_WRITE_TOKEN）
FACILITATOR_URL=... JPYC_PAY_TO=0x... UPSTREAM_SOLANA_PRIVATE_KEY=... BLOB_READ_WRITE_TOKEN=... npm run gateway

# 開発：ログをローカルファイル（log/YYYY-MM-DD.jsonl）に
NODE_ENV=development LOG_SINK=file ... npm run gateway
```

- 起動時に facilitator の `/supported` に `exact` + `JPYC_NETWORK` があるかを確かめ、無ければ起動しない
- `GET /healthz` で設定（ネットワーク・payTo・facilitator・上流ウォレット・価格）を確認できる

### 買い手スクリプト

```sh
BUYER_PRIVATE_KEY=0x... GATEWAY_URL=https://<gateway> POLYGON_RPC_URL=... npm run buyer
```

- 1 回の実行で `BUYER_PATHS`（既定 `/jin/series,/jin/movers`）を 1 回ずつ買って終わる
- `BUYER_DAILY_CAP_JPYC`（既定 20）：JST の 1 日の支出上限。署名する前に判定し、超えるなら支払わずに終了する
- 支出は署名した時点で計上し、送金されていないことが確実な応答（402 など）のときだけ戻す。
  当日の支出は `log/buyer/buyer-YYYY-MM-DD.jsonl` から復元する
- `BUYER_ONCE_PER_DAY`（既定 true）：同じ JST 日に購入済みのパスは買わない
- Phase 1 では `BUYER_PATHS=/jin/series` で 1 回だけ実行する

Phase 2（1 日 1 回の定期実行）は cron で起動する：

```cron
CRON_TZ=Asia/Tokyo
7 9 * * * cd /path/to/poc-jpyc-x402 && npm run buyer >> log/buyer/cron.log 2>&1
```

### Phase 1 の確認

完了条件と確認方法：

| 条件 | 確認 |
|---|---|
| 402 の `accepts` に Polygon・JPYC・金額・payTo が正しく入っている | `curl -si $GATEWAY_URL/jin/series` の `PAYMENT-REQUIRED` / 本文（`amount` は `2000000000000000000`、`extra` は `JPY Coin` / `1`） |
| settle の tx が Polygonscan で確認でき、JPYC が payTo に着金している | 買い手の出力の `polygonscan` リンク、`npm run tx:check -- <txHash> 2` |
| 買い手に JIN の series データが返っている | 買い手の出力 |
| 決済ログ 1 行が出力されている | `npm run logs:summary` |

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
agents/buyer/index.ts   買い手エージェント（@x402/fetch + viem、日次上限）
scripts/                facilitator・domain・settle tx の確認、ログ集計、鍵の作成
```
