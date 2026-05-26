<div align="center">

<sub><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <b>日本語</b> · <a href="README.ko.md">한국어</a> · <a href="README.es.md">Español</a></sub>

<h1>open-browser-use</h1>

<p><b>あなたが普段使っているブラウザを、エージェントに操作させましょう。</b></p>

<img src="open-browser-use-readme-preview-wide.png" alt="open-browser-use — agent browser tool, agentic RL ready" width="820">

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
  <img alt="Status: public preview" src="https://img.shields.io/badge/status-public%20preview-orange?style=flat-square">
  <img alt="Platforms: macOS and Linux" src="https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Linux-lightgrey?style=flat-square">
  <br>
  <img alt="Built with Rust" src="https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white">
  <img alt="Built with TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Model Context Protocol" src="https://img.shields.io/badge/MCP-server-7C3AED?style=flat-square">
</p>

</div>

---

あなたのコーディングエージェントは、推論し、計画を立て、コードを書くことができます。しかしタスクがログインの先にあったり、APIのないダッシュボードの中にあったり、クリックを重ねる複数ステップのWebフォームに潜んでいたりすると、たちまち壁にぶつかります。頭脳は十分でも、ブラウザを操作する「手」がないのです。**open-browser-use は、その手を与えます** — クラウドではなく、あなた自身のマシン上で、*あなた自身の*、すでにログイン済みの実ブラウザを操作します。

## エージェントには頭脳はあっても、手がない

私たちはつい、エージェントに「あとはよろしく」と任せたくなります。問題は、その「あとはよろしく」の多くがブラウザのタブの中で完結することです。

- 「今四半期にメールで届いた請求書をすべてダウンロードして、合計を出して。」
- 「いつものスーパー（もうログイン済み）から、定番の食料品を再注文して。」
- 「このダッシュボードの数値を抜き出して — エクスポートボタンがないんだ。」
- 「あのPDFの内容を使って、この申込書を埋めて。」

どれも*考える*のが難しいわけではありません。難しいのは、エージェントがページに*触れられない*からです。open-browser-use はそのギャップを埋めます。しかも、できるだけ気持ちよく使えるやり方で。

- **あなたの実ブラウザ、あなたのセッション。** まっさらでログアウト状態のロボット用ブラウザではなく、あなたが普段使っている Chrome を、ログインや Cookie ごと操作します。だからこそ、あなたの*本当の*用事をこなせます。
- **ローカルでプライベート。** すべてがあなたのマシン上で動きます。クラウドもアカウントも不要で、どこにもデータを送信しません。
- **手持ちのエージェントとそのまま連携。** Codex、Claude Code、Cursor、Gemini CLI、VS Code など — Model Context Protocol (MCP) を介して連携します。
- **オープンソース**、MIT ライセンスです。

## インストール（現在はプレビュー版）

open-browser-use は **macOS / Linux 向けの公開プレビュー版**です。Chrome ウェブストアへの掲載はまだ公開されていないため、拡張機能は GitHub Releases から配布しています。手作業でセットアップするのはひとつだけ — ブラウザ拡張機能です。残りはすべて、あなたの AI エージェントがインストールして接続してくれます。

1. 最新リリースから **[拡張機能をダウンロード](https://github.com/open-browser-use/open-browser-use/releases/latest/download/open-browser-use-extension.zip)** して、解凍します。
2. **ブラウザに読み込みます。** `chrome://extensions`（Chrome またはその他の Chromium 系ブラウザ）を開き、**デベロッパーモード**をオンにして、**パッケージ化されていない拡張機能を読み込む**をクリックし、解凍したフォルダを選択します。拡張機能はピン留めしておきましょう — 次のステップでエージェントを接続するのは、そのポップアップからです。

> [!NOTE]
> Chrome ウェブストアへの掲載が公開されれば、ダウンロードや解凍は不要で、ストアから直接拡張機能を追加できるようになります。プラットフォームごとの注意点やトラブルシューティングについては、[docs/install.md](docs/install.md) と [docs/troubleshooting.md](docs/troubleshooting.md) を参照してください。

## クイックスタート

拡張機能を読み込めば、コーディングエージェントへの接続は1分ほどで完了します — 設定ファイルを手で編集する必要はありません。

1. **拡張機能のポップアップを開き**、**Copy for agent** をクリックします。
2. **それをコーディングエージェントに貼り付けます**（Codex、Claude Code、Cursor、Gemini CLI など）。
3. エージェントが **open-browser-use の MCP サーバーをセットアップし、あなたのブラウザに接続します。** これだけです。

> [!TIP]
> あとは、ふつうの言葉で頼むだけです。
> *「GitHub の通知を開いて、本当に対応が必要なものだけ要約して。」*

## エージェントにできること

内部では、エージェントはひとつの `js` ツールを呼び出し、Playwright 風の SDK（`agent` グローバル）に対してコードを書きます。ブラウザ操作の1ターンは、これくらいコンパクトです。

```js
const browser = await agent.browsers.get("chrome");
const tab = await browser.tabs.current();
await tab.attach();                                   // タブの制御を引き受ける
await tab.goto("https://news.ycombinator.com");
await tab.getByRole("link", { name: "new" }).click();
display(await tab.locator("h1").innerText());         // 結果を表に出す
await browser.turnEnded();                            // 制御を返しつつ、セッションは維持する
```

ここからエージェントは、次のことができます。

| 機能                         | その意味                                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **要素を操作する**          | クリック、入力、タイプ、キー押下、選択、ホバー — ロール・テキスト・CSS でアドレス指定（堅牢な Playwright 流のやり方）。                  |
| **見た目や DOM id で操作する** | きれいなセレクタが存在しない場合に備えた、ビジョン／座標ベースおよび DOM アドレス指定のモダリティ — クロスオリジンの iframe をまたいだ操作も含みます。 |
| **読み取り・抽出する**           | テキスト、テーブル、属性、スクリーンショット。                                                                                  |
| **ファイルとダイアログ**          | アップロード、ダウンロード、アラート、確認ダイアログ。                                                                                  |
| **タブ・セッションと再開**  | 複数のタブやセッションを操り、長いタスクをターンをまたいでも進行状況を見失わずに再開します。                             |

## 仕組み

エージェントは、open-browser-use を MCP サーバーとして扱って対話します。ひとつの `js` ツールを通じて JavaScript を書き、それは `agent` を SDK とする永続的な Node ランタイム上で実行されます。これらの呼び出しは、ケイパビリティで制御されたオーナー専用の Unix socket を通じて JSON-RPC として **`obu-host`** に送られます。`obu-host` はセッションごとのブローカーで、次の2つのバックエンドのいずれかを通じてブラウザを操作します。

```
your agent
   │  MCP over stdio              (`js` ツール。あなたが JS を書き、SDK は `agent`)
   ▼
obu-node-repl                     (MCP サーバー + それが起動する Node ランタイム)
   │  JSON-RPC over an owner-only Unix socket   (ケイパビリティで制御)
   ▼
obu-host                          (セッションごとのブローカーデーモン)
   ├─▶ WebExtension backend ─▶ your everyday Chrome        (MV3 + native messaging、デバッグポート不要)
   └─▶ CDP backend          ─▶ Chrome with remote debugging   (OBU_CDP_URL)
```

- **WebExtension バックエンド** — 通常どおりインストールした Chrome を、open-browser-use 拡張機能を通じて操作します。`--remote-debugging-port` は不要で、あなたの実プロファイルとログインはそのまま保たれます。日常利用ではこれがデフォルトです。
- **CDP バックエンド** — リモートデバッグを有効にして起動された任意の Chrome（`OBU_CDP_URL`）にアタッチします。ヘッドレス実行やスクリプト実行に最適です。

> [!IMPORTANT]
> すべてはあなたのマシン上にとどまります。`obu-host` の socket はオーナー専用で、OS ユーザーによって認証されます。そこへ到達できるケイパビリティトークンを持つのは信頼された SDK コードだけです — open-browser-use がリモートのサービスに通信することは一切ありません。

<details>
<summary><b>リポジトリ構成</b> — それぞれの部品がどこにあるか</summary>

| パス                              | 内容                                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `crates/obu-wire`               | 共有の JSON-RPC フレーミング、エンベロープ、エラーコード。                                                                  |
| `crates/obu-node-repl`          | MCP サーバー。Node ランタイム（SDK が動く場所）を起動し、`obu-host` へのケイパビリティ制御された socket を仲介します。 |
| `crates/obu-host`               | セッションごとのブローカーデーモンと、CDP / WebExtension バックエンド。                                                    |
| `packages/sdk`                  | エージェント向けの、Playwright 風 TypeScript SDK（`@open-browser-use/sdk`）。                                       |
| `packages/browser-control-core` | SDK と拡張機能が共有する、純粋なプロトコル型・プランナー・フィクスチャ。                                          |
| `packages/cli`                  | `obu` コマンドライン — `setup`、`verify`、`doctor`、そしてエージェントの MCP 連携。                                  |
| `packages/extension`            | Chromium MV3 拡張機能と、そのネイティブホストブリッジ。                                                                |

</details>

## エージェント型 RL 環境

open-browser-use は、ブラウザエージェントを単に*動かす*だけでなく、**学習・評価するための環境**としても使えるように設計されています。強化学習のコア部分はすでに存在しており、残っているのはその周りを固めるハーネスです。

**すでに用意されているもの**

- **環境風のアクション／観測ループ。** `tab.observe()` は型付きの `TabObservation` を返し、`tab.step(action)` は型付きの `EnvAction` を受け取って `ActionResult` を返します。`EnvAction` は、3つのアドレス指定モード — `locator.*`、`dom_cua.*`、`coordinate.*` — にまたがる **13 種類のアクション**をカバーし、それぞれにオプションのケイパビリティ `policy` を指定できます。
- **リッチで構造化されたステップ結果。** `ActionResult` は `ActionEffect`（`navigation`、`dom_changed`、`download_started`、`no_visible_change` など）、`invalidatedObservations`、各種ハンドル、アドバイザリ、そして構造化された `error` を報告します — 学習器や検証器を駆動するのに十分なシグナルです。
- **回復機能を備えた永続的なエピソード。** セッションは所有権の調停、ステイルハンドルの診断、オーナーターンの証明、そして `resume` を備えているため、長いエピソードもクラッシュや再接続を乗り越えられます。タスクは `EpisodeExport { task_id, turns, events }` としてエクスポートされます。
- **高レベルのヘルパー**（`tab.act.*`、`tab.flows`、`tab.read`）が、同じプリミティブの上に重ねられています。

**まだ用意されていないもの** — 形式的でサンプリング可能な `reset/step/observe/close` を公開する単一の `Environment` ファサードはまだありません。`browser.reset()` はビューポートをリセットするだけです（バックエンドは使い捨てのブラウザを起動するのではなく、既存のブラウザにアタッチします）。また、組み込みの検証器基盤、報酬を伴うトラジェクトリスキーマ、並列ロールアウトのフリート、Python / ネットワーク（HTTP/gRPC）クライアントもまだありません — 現時点での提供面は、MCP-stdio とネイティブパイプのブローカーです。

### 学習可能な環境へのロードマップ

「実際にこれを相手に学習できるか」というクリティカルパスの順に並べています。

- [ ] **Env ファサード + 言語非依存のプロトコル + Python クライアント** *(要)* — `reset/step/observe/close` を HTTP/gRPC の面（あるいは一般的な RL フレームワーク向けのアダプタ）の背後に集約し、外部のトレーナーが大規模にロールアウトを駆動できるようにします。
- [ ] **クリーンでシード付きの `reset()`** — バックエンドが、まっさらなプロファイルと固定のスタート URL を持つ使い捨てブラウザを起動し、エピソード終了時に破棄できるようにします。この1つの機能が、リセット*と*並列化の両方を可能にします。
- [ ] **検証器基盤（RLVR）** — 決定論的なアサーションライブラリ（`url_contains`、`text_visible`、`dom_query`、`download_produced`、JS 述語）に加えて、`episode.evaluate({ assertions })`。
- [ ] **学習に使えるトラジェクトリスキーマ** — `EpisodeExport.turns` を `(obs, action, effect, reward, done)` レコードとして型付けし、標準的な JSONL / Hugging Face データセット形式でエクスポートできるようにします。
- [ ] **並列ロールアウトのフリート** — 非同期にステップを進められる、N 個の隔離されたブラウザのプール（クリーンなリセットの上に構築します）。
- [ ] **決定性と再現性** — シード付け、オプションのネットワーク記録／再生、そしてコンテンツハッシュ付きの固定タスクインスタンスによる、ライブ Web のドリフト検出。

## デフォルトでローカル

open-browser-use がリモート URL やプロダクトポリシーサービスを呼び出すことは一切ありません。SDK のガードとホストポリシーはローカルで動作し、デフォルトでは緩やかな設定です。必要に応じて、環境変数で締めることができます。

| 変数                                                                      | 効果                                                               |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `OBU_HOST_POLICY_DENY_ORIGINS`                                              | 指定したオリジンに対するナビゲーションと現在オリジン向けコマンドをブロックします。 |
| `OBU_HOST_POLICY_DENY_CDP_METHODS`                                          | 特定の生の CDP メソッドをブロックします（`*` ですべてをブロック）。                   |
| `OBU_HOST_POLICY_BLOCK_HISTORY` / `_BLOCK_DOWNLOADS` / `_BLOCK_UPLOADS` | 履歴の読み取り、ダウンロード、アップロードをブロックします。                          |
| `OBU_GUARD_MODE=disabled`                                                   | すべてのガードとポリシーチェックをローカル／テスト用にバイパスします。                |

SDK の呼び出し側は、ブラウザごとに `Guards` フックを、ナビゲーション・ダウンロード・アップロード・履歴・生の CDP に対して設定することもできます — これらはあなたのローカルのエージェントプロセス内で動作し、ネットワークリクエストは一切発生しません。

```ts
import { Guards } from "@open-browser-use/sdk";

const browser = await agent.browsers.get("chrome", {
  guards: new Guards({
    checkNavigation(url) {
      if (url.startsWith("https://admin.example/")) throw new Error("navigation blocked");
    },
  }),
});
```

## ビルドとテスト

```bash
cargo test --workspace
pnpm install --frozen-lockfile
pnpm -r build && pnpm -r test
```

ワイヤメソッド名、SDK のガードクラス、ホストポリシークラス、そしてバックエンドのサポート状況は、すべて `wire/methods.json` に由来します。ワイヤメソッドを変更したら、TS/Rust のテーブルを再生成して、最新状態のチェックを実行してください。

```bash
pnpm generate:wire-methods
pnpm check:wire-methods
```

パッケージング、カバレッジ、そして `#[ignore]` 指定された CDP / WebExtension のエンドツーエンドゲートには、それぞれ専用のスクリプトとセットアップがあります。[docs/install.md](docs/install.md)、[docs/troubleshooting.md](docs/troubleshooting.md)、[docs/release-checklist.md](docs/release-checklist.md) を参照してください。

## ライセンスと告知

open-browser-use は MIT ライセンスです — [LICENSE](LICENSE) を参照してください。リリースのペイロードには、それぞれの上流ライセンスのもとで提供されるサードパーティコンポーネントも含まれます。詳細は [LICENSE-THIRD-PARTY.md](LICENSE-THIRD-PARTY.md) にあります。

---

<div align="center">
<sub>Rust + TypeScript で構築 · Model Context Protocol を介して駆動 · macOS / Linux 公開プレビュー</sub>
</div>
