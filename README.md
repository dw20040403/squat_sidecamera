# スクワット姿勢計測システム

2台のiPhoneのカメラ映像から、スクワット中の3D姿勢をリアルタイムで推定し、膝・体幹・足部の指標を表示します。
仕様は [`spec.md`](spec.md)、実装の手順は [`plan.md`](plan.md)、人が決める項目は [`todo.md`](todo.md) を参照してください。

## 構成

```
server/   HTTPS配信とWSSシグナリング（同じポート、既定8443）
web/      主端末・副端末（index.html?role=main|sub）とオフラインモード（offline.html）
  src/fusion/   カメラモデル、歪み補正、三角測量、左右補正、フィルタ、補間、Fuser（DOMに依存しない）
  src/metrics/  指標の計算（DOMに依存しない）
  src/monitor/  異常検知、fps計測、警告音
  src/net/      シグナリング、WebRTC、時刻同期
  src/calib/    ArUco検出（OpenCV.js / js-aruco2）、solvePnP、カメラ配置
  src/capture/  カメラ、フレームの取得、録画、Wake Lock
  src/pose/     MediaPipe Pose Landmarker のラッパー
  src/render/   2D描画、3D描画（Three.js）、グラフ、配置図
  src/record/   セッション形式、IndexedDB、ZIP
  src/feedback/ 将来拡張用のインターフェース（FeedbackEngine、Speaker）
  src/offline/  オフライン処理
  src/ui/       画面
config/   params.json（しきい値・係数）、layout.json（配置）、board.json（ArUcoボード）、intrinsics/（内部パラメータ）
tools/    calibrate_intrinsics.py、gen_aruco_board.py
tests/    単体テスト（Vitest）、合成データ、誤差のレポート、E2E（Playwright）
scripts/  証明書の作成、MediaPipeなどのファイルの配置
```

## セットアップ（Mac）

必要なもの：Node.js（LTS）、Python 3、`pip install opencv-contrib-python pillow`、`brew install mkcert nss`

```bash
npm install
```

```bash
npm run setup:assets
```

MediaPipeのwasm・モデル（full・lite）、OpenCV.js、js-aruco2 を `web/public/` に配置します（モデルだけインターネットからダウンロードします。一度だけ）。

```bash
npm run setup:certs
```

mkcertで `certs/` に証明書を作り、iPhoneにルート証明書を入れる手順を表示します。MacのIPアドレスが変わったら作り直してください。

```bash
npm run build && npm start
```

起動すると、主端末・副端末・オフラインモードのURLとQRコードが表示されます。

- 主端末：`https://<MacのIP>:8443/?role=main`
- 副端末：`https://<MacのIP>:8443/?role=sub`
- オフラインモード：`https://<MacのIP>:8443/offline.html`

開発中は `npm run dev` で、Viteの開発サーバーを同じポートで動かします（HTTPS・ホットリロード）。
証明書がない場合はHTTPで起動します（Macのブラウザの `localhost` では動きますが、iPhoneのカメラにはHTTPSが必要です）。

### iPhoneの準備
1. ルート証明書をインストールし、「設定 → 一般 → 情報 → 証明書信頼設定」で信頼をオンにする（`npm run setup:certs` の表示に従う）
2. 「設定 → Safari → 詳細 → Webインスペクタ」をオンにする
3. 縦置きで三脚に固定する

### 実機のデバッグ
iPhoneをMacにケーブルでつなぎ、MacのSafariの「開発」メニューからiPhoneのページを選ぶと、Webインスペクタでコンソールやネットワークを確認できます。
主端末の画面右上に、推論時間・撮影から統合までの時間・統合fps・再投影誤差・受信量を表示しています。

## 使い方

### 1. 内部パラメータ（端末ごとに一度だけ）
1. チェッカーボード（既定：9×6の交点、1マス25mm）を印刷して平らな板に貼り、1マスの実寸を測る
2. 各端末の「校正画像撮影」で15〜25枚撮影し、ZIPでダウンロードする
3. Macで実行する（RMSが1px未満になるまで撮り直す）
   ```bash
   python3 tools/calibrate_intrinsics.py calib-iphone15-A.zip --device iphone15-A --cols 9 --rows 6 --square 25
   ```
4. 出力された `config/intrinsics/iphone15-A.json` をそのまま置く（サーバーの再起動は不要）
5. 各端末の「設定」で自分の deviceName を選ぶ

校正前に動作を確かめるための仮の値として `config/intrinsics/approx-iphone15.json` を置いてあります（計測には使わないでください）。

### 2. ArUcoボード
```bash
python3 tools/gen_aruco_board.py
```
A2に1枚（`--paper A3x2` でA3横2枚）のPDFを作ります。実寸（100%）で印刷し、目盛りとマーカーの1辺を実測して、ずれていれば `config/board.json` の座標を直します。
ボードは被験者が立つ位置に、印刷の上側（+Y）を被験者の正面、右側（+X）を被験者の右に向けて床に置きます。

### 3. カメラ配置と外部校正（設置のたびに）
1. 主端末の「メニュー → カメラ配置」でプリセットを選び、上から見た図を見ながら三脚を置く
2. 「メニュー → 外部校正」で「検出して計算」を押す（副端末も自動で検出して結果を送ります）→ 結果を確認して「保存」
3. ボードを取り除き、被験者に立ってもらって「メニュー → 校正の確認」で再投影誤差（5px程度以下）と体の向きを確認する

### 4. 測定
主端末の「測定開始」で記録を始めます。開始できない場合は、理由が画面下に表示されます（副端末との接続、内部・外部パラメータ、解像度の一致、時刻同期）。
異常（副端末のデータが届かない、必須の関節が見えない、再投影誤差が大きい、処理速度の低下、往復時間の増加）を検知すると、赤い警告と警告音を出して測定を中止し、それまでの記録を「中止」として保存します。
しきい値は `config/params.json` で変えられます。

「メニュー → セッション一覧」で、再生（表示モード①〜④・シーク・速度・指標のグラフ）、ダウンロード（JSON・CSV・映像）、削除ができます。

### 5. テスト録画とオフラインモード
主端末の「テスト録画」で2台が同時に録画します。止めると、各端末で動画と `<role>-meta.json`（主端末は `calibration.json` も）をダウンロードできます。
`offline.html` で5つのファイルを読み込むと、リアルタイム処理と同じモジュールで処理します。記録したセッションのJSONを読み込むと、2Dデータから統合と指標だけを計算し直します。
統合のパラメータを画面で変えて「再計算」すると、推論をやり直さずに結果を比較できます。

## テスト

```bash
npm test
```
単体テスト（計算部分・時刻同期・異常検知・シグナリングなど）。

```bash
npm run report
```
合成データの誤差のレポートを `tests/reports/synthetic-report.md` に出力します（配置のプリセットごと、交差角30〜120°、One Euroの係数の比較）。

```bash
npm run test:e2e
```
ビルドしてから、Playwright（偽のカメラ）で、オフラインモードの再計算・推論の流れ、主端末と副端末の接続・時刻同期・再接続、測定の開始と異常による中止を確認します。
`tests/fixtures/videos/` にテスト動画（`main.mp4`・`sub.mp4`・`main-meta.json`・`sub-meta.json`・`calibration.json`）と `tests/fixtures/baseline.json` を置くと、実際の動画の回帰テスト（CPUデリゲート）も実行します（`tests/fixtures/baseline.example.json` を参照）。

その他：`npm run typecheck`、`npm run lint`、`npm run format`

## 実装で決めたこと（todo.mdの既定案の採用を含む）

未決の項目は、仕様書・todo.mdの既定案で実装しました。既定案がない項目は次のようにしています。いずれも後から変えられます。

| 項目 | 実装 | 変更する場所 |
|---|---|---|
| deviceName | `iphone15-A`（主）、`iphone15-B`（副） | 各端末の設定画面 |
| ArUcoボード | 4×4_50、1辺150mm、2×2、間隔50mm | `config/board.json` |
| 副端末のデータが届かないとき | 最大50msまで外挿、それを超えたら欠損 | `params.json` の `fusion.maxExtrapMs` |
| `fusionDelayMs`の基準 | 主端末のフレーム時刻（撮影時刻）t_m から120ms | `fusion.fusionDelayMs` |
| CSVの`null` | 空欄 | — |
| セッションID | 現地時刻 `YYYYMMDD-HHMMSS` | — |
| 主端末側の左右の取り違え | 補正しない（副端末側だけ補正） | todo.md フェーズ5 |
| 測定開始のカウントダウン | 既定0秒（設定で0〜30秒） | 主端末の設定画面 |
| ArUcoの検出 | OpenCV.js（ArucoDetector＋solvePnP）。読み込めない・動かない場合は js-aruco2＋自前のsolvePnP | 設定画面で固定もできる |
| 保存データ | 一覧を開いたときに `navigator.storage.persist()` を要求する | — |
| 警告音 | 880Hzの断続音、1.5秒、音量0.3 | `params.json` の `alarm` |

仕様のメッセージ・データ形式に、次の項目を追加しています（既存の項目は変えていません）。
- `status`（ctrl）に時刻同期の状態（`synced`・`offsetMs`・`rttMs`・`probeRttMs`）と推論時間。主端末は往復時間の監視（5.9節）にこの値を使います。
- `sync-req`/`sync-res` に `id` と `kind`（ずれの計測か、監視用か）。
- `notice`（副端末からの通知）、`test-rec-done`（副端末の録画の完了）。
- セッションの `video`（主カメラの録画の開始時刻と形式。再生で映像と骨格を合わせるため）と `offline`（オフライン処理の条件）。

### 実装中にわかったこと
- **左右対称の配置での左右の取り違えの判定**：2台が体の正中面に対して対称に近い配置（既定の正面の左右±45°）では、副端末の左右を誤って対応させても「その場で向きを変えた体」として幾何的に成り立ち、再投影誤差がほぼ0になります。再投影誤差だけでは判定できないため、誤差の差が `fusion.swapMarginPx`（3px）未満のときは「足部（かかと→足先）が腰の左右軸にほぼ直交するか」で判定しています。合成データでは交差角30〜120°で正しく判定できていますが、実際のデータでの確認が必要です。
- **補間時の左右の混ざり**：副端末の前後のフレームで左右が入れ替わっていると、補間で左右の点が混ざります。補間の前に、2つのフレームの左右を揃えるようにしました。
- **平滑化の遅れ**：合成データ（周期3秒、2D誤差2px）では、平滑化なしの膝の曲げ角度の誤差は約1°ですが、One Euro（minCutoff 1.0、beta 5.0）をかけると遅れのため約4°になります。2D誤差5pxでも同様の傾向です（`npm run report` の3節）。係数は実データで調整してください（todo.md フェーズ5）。

### 実機での確認が必要なこと
plan.md の `[実機]` の項目はすべて未確認です。特に次の点は、結果によって設計が変わる可能性があります。
- `getUserMedia` で選ばれる背面カメラ（ラベルから標準広角を選ぶようにしています）、レンズの自動切り替え、`captureTime` が取れるか（設定画面の「カメラの情報」に表示します）
- OpenCV.js（約10MB）がiOSのSafariで読み込めるか、読み込み時間（外部校正の画面に表示します。動かなければ自動で js-aruco2 に切り替わります）
- iPhone 15での推論時間（GPU）、録画と推論の同時実行、10分間の連続稼働
- 2台の接続（STUNなし、host候補のみ）と時刻同期の安定性
