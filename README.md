# ETF Swing Monitor

SOXLを主対象、TQQQを副対象に、価格とニュースを監視するAndroid向け個人用PWAのプロジェクトです。

**価格履歴・参考指標・通知・資産台帳を実装しました。価格条件の仮説と過去検証も追加しました。実用の売買判断・ニュース分析は未実装です。**

所有者ログイン、SOXL/TQQQの日足取得、Android向けPWA、即時・予約プッシュ通知の実装があります。ローカルテストと実際のAlpaca/Cloudflare/Androidでの実証は区別しています。Alpaca・Cloudflare接続とAndroidへの予約通知到着を確認済みです。約400暦日の履歴と参考指標を表示できます。

## 起動

Node.js 24以降。

```sh
npm ci
npm run setup
npm run dev
```

生成された `private/owner-token.txt` の所有者キーでログインします。Alpacaキーが未設定でも画面を確認できますが、ダミーの価格や売買判断は表示しません。

[無料アカウントの設定・デプロイ・Android確認手順](docs/SETUP.md)

## 検証

```sh
npm run check
npm run test:browser
```

`check` は型・単体・ビルド・Worker/D1統合テスト。ブラウザテストはローカルChromeまたはPlaywright Chromiumを使用します（未インストール時は `npx playwright install chromium`）。実データ取得・端末への到着を代用するテストではありません。

[接続の実証状況](docs/P1_STATUS.md) / [価格履歴と指標の仕様](docs/DATA_PHASE.md) / [資金・保有台帳の仕様](docs/PORTFOLIO.md) / [価格ルールの検証](docs/PRICE_RULES.md)

## プロジェクト全体で予定する機能

- 数週間のスイング向けに購入・買い増しの判断材料と出典を表示。利益時の売却候補の範囲は確認中。
- 含み損時は売却候補を出さず、悪材料と買い増し停止を表示。
- SOXLとTQQQの情報を日本時間の1日につき最大1件にまとめて通知。
- 初回起動時に待機資金と既存保有を入力。米ドル建ての損益を記録。
- 所有者が購入・売却・入出金を記録。楽天証券への自動注文は行わない。
- PC常時起動を必要としないクラウド監視。月額サービス料金0円を必須とし、実測で構成を決定。

## 公開範囲

ソースコードは公開、稼働アプリは所有者専用です。APIキー、保有情報、個人の予算、運用DB、取得記事本文はリポジトリに含めません。実際の個人設定はデプロイ先で管理します。

## ドキュメント

- [実装計画](docs/IMPLEMENTATION_PLAN.md)
- [決定事項](docs/DECISIONS.md)
- [実証チェックリスト](docs/VALIDATION.md)

まず無料データ取得とAndroid通知を実証し、価格のみの戦略を比較基準として検証します。その後にニュース分析の追加効果を評価します。現段階で収益性や判断精度が実証されたシステムではありません。

## ライセンス

[MIT](LICENSE) — Copyright (c) 2026 Gingnose
