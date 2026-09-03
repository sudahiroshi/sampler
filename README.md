# 効果音サンプラー

ブラウザ上でアイコンをタップ／クリックすると効果音が鳴る、クイズ進行やイベント司会向けのサンプラーです。
HTML / Vanilla JS / CSS だけで書かれており、フレームワークもビルドツールも使いません。
静的ファイルを配信するだけで動き、再生処理はすべてクライアントサイドで完結します。

- 音源は Web Audio API で再生し、一度読み込んだ AudioBuffer はメモリに保持します（2 回目以降は再取得しません）
- 音量は音源ごとに調整でき、`localStorage` に保存されて次回起動時に復元されます
- 「起動時に全部読み込む」を有効にすると、起動直後にすべての音源を先読みします
- テーマは「システム設定に従う（既定）/ ライト / ダーク」の 3 択で、選択は保存されます
- iPhone / iPad の Safari を想定した対応を入れています（後述）

## 起動方法

静的ファイルを配信するだけです。`file://` で開くと ES Modules と `fetch` が使えないため、必ず HTTP で配信してください。

```sh
cd path/to/sampler
python3 -m http.server 8123
```

ブラウザで <http://localhost:8123/> を開きます。
同じ Wi-Fi 上の iPhone / iPad から使う場合は、PC の LAN IP を指定してアクセスします（例: `http://192.168.1.10:8123/`）。

Node.js がある場合は次でも構いません。

```sh
npx http-server -p 8123
```

## 使い方

- タイルをタップすると再生、再生中にもう一度タップすると停止します
- 再生中のタイルは緑色の枠と「再生中…」表示になります
- 「■ 全停止」ですべての音を止めます（ドラムロールを途中で切るとき用）
- 各タイルのスライダーで音量を 0〜100% に調整できます。変更は即座に保存されます
- 「起動時に全部読み込む」をオンにすると、次回以降の起動時にすべての音源を先読みします
  （オンにした時点でもその場で読み込みます）。オフのときは初回タップ時に読み込みます
- 「テーマ」で配色を切り替えられます。「システム設定に従う」のときは OS のダーク／ライト設定に
  追従し、OS 側を切り替えると再読み込みなしで即座に反映されます

## 音源の追加手順

`sounds/manifest.json` に 1 エントリ追加し、対応する音声ファイルを `sounds/` に置くだけです。
**JavaScript を変更する必要はありません。**

```json
{
  "id": "applause",
  "name": "拍手",
  "icon": "👏",
  "file": "applause.wav",
  "defaultVolume": 0.9
}
```

| フィールド | 内容 |
| --- | --- |
| `id` | 音源の識別子。音量の保存キーにも使うので、後から変えないこと |
| `name` | タイルに表示する名前 |
| `icon` | タイルに表示するアイコン（絵文字。外部フォントに依存しないため） |
| `file` | `sounds/` からの相対ファイル名 |
| `defaultVolume` | 音量の初期値（0〜1）。ユーザーが調整すると保存値が優先される |

`file` はブラウザが再生できる形式なら WAV 以外（mp3 / m4a など）でも構いません。

## 音源の再生成方法

同梱の WAV は Node.js 標準モジュールだけで合成しています（外部素材のダウンロードはしていません）。

```sh
node tools/generate-sounds.mjs
```

`sounds/` 配下の `fanfare.wav` / `drumroll.wav` / `correct.wav` / `wrong.wav` が再生成されます。
乱数は固定シードなので、実行するたびに同じ結果になります。

生成物の検証:

```sh
node tests/verify-wav.mjs   # ヘッダ・長さ・振幅（無音でない/クリッピングしていない）を実測
node tests/contrast.mjs     # 両テーマのコントラスト比を WCAG の式で実測
node --test 'tests/*.test.mjs'
```

## クラス構成

責務ごとに ES Module のクラスへ分割してあり、UI を差し替えても再生ロジックはそのまま再利用できます。

| ファイル | 責務 |
| --- | --- |
| `js/AudioEngine.js` | `AudioContext` の生成・unlock・デコード。ブラウザ差異をここで吸収する |
| `js/Sound.js` | 音源 1 つの読み込みと再生。AudioBuffer を保持し、GainNode で音量を掛ける。DOM に触れない |
| `js/SoundLibrary.js` | `manifest.json` から `Sound` の集合を組み立て、プリロードと全停止をまとめる |
| `js/SettingsStore.js` | `localStorage` への永続化。使えない環境ではメモリへ自動フォールバックする |
| `js/ThemeController.js` | 選択値と OS 設定から適用テーマを決め、`data-theme` を付ける。保存は `SettingsStore` に委譲 |
| `js/DebugLog.js` | `?debug=1` のときだけ画面に診断ログを出す。通常表示では何も描画しない |
| `js/SamplerUI.js` | タイルの描画とイベント処理。再生ロジックは持たない |
| `js/main.js` | 上記を組み立てる配線だけ |

依存の向きは `main → UI → SoundLibrary → Sound → AudioEngine` の一方向で、
`Sound` / `SoundLibrary` / `SettingsStore` は DOM に依存しないため Node.js 上でテストできます。

## テーマ（配色）の仕組み

配色は CSS カスタムプロパティに集約してあり、個々のセレクタに色を直書きしていません。

```css
:root, html[data-theme='light'] { --bg: …; color-scheme: light; }
html[data-theme='dark']         { --bg: …; color-scheme: dark; }
```

- 適用テーマは `<html data-theme="light|dark">` で決まります。「システム設定に従う」を選んでいる場合は
  `prefers-color-scheme` の結果を `ThemeController` が解決して属性へ書き込みます
- `color-scheme` を指定しているので、音量スライダーやセレクトなどのフォームコントロールと
  スクロールバーもテーマに追随します
- 初期表示のちらつき（白フラッシュ）を避けるため、`index.html` の `<head>` 内・**スタイルシートを読む前**の
  同期スクリプトで `data-theme` を確定させています。`<script type="module">` は defer 扱いになり
  最初の描画に間に合わないため、ここだけモジュールではなく素の `<script>` です
- 色を変えるときは `css/style.css` のトークンだけを編集し、`node tests/contrast.mjs` で
  コントラスト比（本文とタイルのラベルは 4.5:1 以上）を確認してください
- `data-theme` が付かない場合（JavaScript を無効にした場合など）はライトが当たります。
  その状態ではアプリ自体が動かないため、フォールバックの見た目のみの意味です

## iOS / iPadOS での注意点

- **最初のタップまで音は鳴りません。** iOS は最初のユーザー操作がないと `AudioContext` を起動しないため、
  タイルを 1 回タップした時点で unlock 処理（無音バッファの再生と `resume()`）が走ります
- **消音（サイレント）モードでは音が出ません。** Web Audio は消音スイッチの影響を受けます。
  本番前に消音モードを解除し、本体音量を上げて確認してください。
  以前は無音の `<audio>` を鳴らしてオーディオセッションを起こす対策を入れていましたが、
  その要素が鳴り終わった時点でセッションが解放され、**再生中の音まで中断される**不具合があったため取り外しました
- ホーム機能から戻った場合や他アプリの音・着信のあとは、`AudioContext` が `suspended` または
  iOS 独自の `interrupted` に落ちます。再生のたびに「`running` 以外なら `resume()`」を試みるため、
  タップし直せば復帰します。`AudioContext` はアプリ全体で 1 個だけ生成し、`close()` は呼びません
- ダブルタップズームとタップ遅延は `touch-action: manipulation` で抑止しています
- 高さは `100dvh` を使っているため、アドレスバーの伸縮でレイアウトが崩れません
- **本番前に一度リハーサルしてください。** 起動時プリロードをオンにしておくと、
  本番中の初回タップで読み込み待ちが発生しません

## 不具合が出たときの診断（`?debug=1`）

iOS Safari は手元でコンソールが見られないため、URL に `?debug=1` を付けると画面下に診断ログが出ます。

```
http://<サーバの IP>:8123/?debug=1
```

記録されるのは次の 4 種です。通常の URL では何も表示されず、ログも記録しません。

| 種別 | 内容 |
| --- | --- |
| `context` | `AudioContext` の生成（何個目か）と state の遷移（`suspended` / `running` / `interrupted`）、`resume()` の試行結果 |
| `event` | タイルで発火したイベント（`pointerdown` / `touchstart` / `touchend` / `click`）と、重複として無視した操作 |
| `play` | 再生開始（そのときの state と保持ノード数）、停止、再生終了 |
| `error` | `unlock` / `resume` / 音源読み込みの失敗 |

「音が途中で切れる」ときは `context` 行で state が `interrupted` や `suspended` に落ちていないか、
「タップしたのに鳴らない」ときは `event` 行が 1 タップで 2 回出ていないかを見てください。

## ディレクトリ構成

```
.
├── index.html                 アプリのシェル（ヘッダ・グリッドの器）
├── css/style.css              スタイル（外部フォント・CDN に依存しない）
├── js/                        クラス群（上表を参照）
├── sounds/
│   ├── manifest.json          音源の定義。ここに追記するだけで音源が増える
│   └── *.wav                  生成済みの音源
├── tools/generate-sounds.mjs  音源を合成生成するスクリプト
└── tests/                     Node.js で動くテスト
```
