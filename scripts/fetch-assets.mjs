// MediaPipeのwasm・モデル、OpenCV.js、js-aruco2を web/public/ に配置する
// npmパッケージからコピーし、モデルはダウンロードする（一度だけ実行すればよい）
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'web', 'public');
// npm workspacesでは依存はルートのnode_modulesに置かれる（web/node_modulesの場合もある）
const pkgDir = (name) => {
  for (const base of [join(root, 'web', 'node_modules'), join(root, 'node_modules')]) {
    const d = join(base, name);
    if (existsSync(join(d, 'package.json'))) return d;
  }
  throw new Error(`パッケージが見つかりません: ${name}（npm install を実行してください）`);
};

const MODELS = {
  lite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
  heavy:
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task',
};

const args = process.argv.slice(2);
const wanted = args.filter((a) => !a.startsWith('--'));
const models = wanted.length ? wanted : ['full', 'lite'];
const force = args.includes('--force');

function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(src)) {
    const s = join(src, f);
    const d = join(dst, f);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
}

// 1. MediaPipeのwasm
const wasmSrc = join(pkgDir('@mediapipe/tasks-vision'), 'wasm');
copyDir(wasmSrc, join(pub, 'mediapipe', 'wasm'));
console.log('MediaPipe wasm → web/public/mediapipe/wasm');

// 2. モデル
mkdirSync(join(pub, 'mediapipe', 'models'), { recursive: true });
for (const m of models) {
  const url = MODELS[m];
  if (!url) {
    console.warn(`不明なモデル: ${m}（lite / full / heavy）`);
    continue;
  }
  const dst = join(pub, 'mediapipe', 'models', `pose_landmarker_${m}.task`);
  if (existsSync(dst) && !force) {
    console.log(`モデル ${m}: 既にあります`);
    continue;
  }
  process.stdout.write(`モデル ${m} をダウンロード中… `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ダウンロードに失敗しました: ${url} (${res.status})`);
  writeFileSync(dst, Buffer.from(await res.arrayBuffer()));
  console.log(`${(statSync(dst).size / 1e6).toFixed(1)}MB`);
}

// 3. OpenCV.js（ArUco対応ビルド。校正画面でだけ読み込む）
try {
  const cvSrc = join(pkgDir('@techstark/opencv-js'), 'dist', 'opencv.js');
  mkdirSync(join(pub, 'opencv'), { recursive: true });
  copyFileSync(cvSrc, join(pub, 'opencv', 'opencv.js'));
  console.log('OpenCV.js → web/public/opencv/opencv.js');
} catch (e) {
  console.warn('OpenCV.js が見つかりません（npm install を確認してください）:', e.message);
}

// 4. js-aruco2（OpenCV.jsが動かない場合の代替）
const arucoDir = pkgDir('js-aruco2');
mkdirSync(join(pub, 'vendor', 'js-aruco2'), { recursive: true });
for (const f of ['src/cv.js', 'src/aruco.js', 'src/dictionaries/aruco_4x4_1000.js']) {
  copyFileSync(join(arucoDir, f), join(pub, 'vendor', 'js-aruco2', f.split('/').pop()));
}
console.log('js-aruco2 → web/public/vendor/js-aruco2');
console.log('完了');
