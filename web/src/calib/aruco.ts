// ArUcoマーカーの検出（spec 5.4.2）。OpenCV.js（ArUco対応ビルド）を校正画面でだけ読み込む。
// 読み込めない・動かない場合は js-aruco2 に切り替える（IDと4隅の順序はOpenCVと同じであることを確認済み）
import type { Intrinsics, Extrinsics } from '../fusion/camera';
import type { Correspondence } from './pnp';

export interface DetectedMarker {
  id: number;
  /** OpenCVと同じ順序（左上・右上・右下・左下）の画素座標 */
  corners: [number, number][];
}

export interface MarkerDetector {
  readonly name: 'opencv' | 'js-aruco2';
  detect(img: ImageData): DetectedMarker[];
  /** OpenCVのsolvePnP（使えるときだけ） */
  solvePnP?(corr: Correspondence[], intr: Intrinsics): Extrinsics | null;
}

export type DetectorPreference = 'auto' | 'opencv' | 'js-aruco2';

function loadScript(src: string, timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.dataset.src = src;
    const timer = setTimeout(() => reject(new Error(`${src} の読み込みがタイムアウトしました`)), timeoutMs);
    s.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    s.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`${src} を読み込めませんでした`));
    };
    document.head.appendChild(s);
  });
}

let cvPromise: Promise<any> | null = null;

/** OpenCV.jsを読み込む。読み込み時間（ms）も返す */
export async function loadOpenCv(timeoutMs = 60_000): Promise<{ cv: any; loadMs: number }> {
  const t0 = performance.now();
  if (!cvPromise) {
    cvPromise = (async () => {
      await loadScript('/opencv/opencv.js', timeoutMs);
      let cv = (window as any).cv;
      if (cv instanceof Promise) cv = await cv;
      else if (cv && !cv.Mat) {
        await new Promise<void>((res, rej) => {
          const timer = setTimeout(
            () => rej(new Error('OpenCV.jsの初期化がタイムアウトしました')),
            timeoutMs,
          );
          cv.onRuntimeInitialized = () => {
            clearTimeout(timer);
            res();
          };
        });
      }
      if (!cv?.aruco_ArucoDetector) throw new Error('このOpenCV.jsにはArUcoが含まれていません');
      return cv;
    })();
    cvPromise.catch(() => (cvPromise = null));
  }
  const cv = await cvPromise;
  return { cv, loadMs: performance.now() - t0 };
}

class OpenCvDetector implements MarkerDetector {
  readonly name = 'opencv' as const;
  private detector: any;
  constructor(
    private cv: any,
    dictionary: string,
  ) {
    const dictId = cv[dictionary];
    if (dictId === undefined) throw new Error(`OpenCV.jsに辞書 ${dictionary} がありません`);
    const dict = cv.getPredefinedDictionary(dictId);
    const params = new cv.aruco_DetectorParameters();
    // サブピクセルで4隅を求める
    if ('cornerRefinementMethod' in params) params.cornerRefinementMethod = cv.CORNER_REFINE_SUBPIX ?? 1;
    const refine = new cv.aruco_RefineParameters(10, 3, true);
    this.detector = new cv.aruco_ArucoDetector(dict, params, refine);
  }

  detect(img: ImageData): DetectedMarker[] {
    const cv = this.cv;
    const rgba = cv.matFromImageData(img);
    const gray = new cv.Mat();
    const corners = new cv.MatVector();
    const ids = new cv.Mat();
    const rejected = new cv.MatVector();
    try {
      cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
      this.detector.detectMarkers(gray, corners, ids, rejected);
      const out: DetectedMarker[] = [];
      for (let i = 0; i < ids.rows; i++) {
        const c = corners.get(i);
        const d = c.data32F;
        out.push({
          id: ids.data32S[i],
          corners: [0, 1, 2, 3].map((k) => [d[k * 2], d[k * 2 + 1]] as [number, number]),
        });
        c.delete();
      }
      return out;
    } finally {
      rgba.delete();
      gray.delete();
      corners.delete();
      ids.delete();
      rejected.delete();
    }
  }

  solvePnP(corr: Correspondence[], intr: Intrinsics): Extrinsics | null {
    const cv = this.cv;
    const obj = cv.matFromArray(
      corr.length,
      1,
      cv.CV_64FC3,
      corr.flatMap((c) => c.X),
    );
    const img = cv.matFromArray(
      corr.length,
      1,
      cv.CV_64FC2,
      corr.flatMap((c) => [c.u, c.v]),
    );
    const K = cv.matFromArray(3, 3, cv.CV_64F, [intr.K.fx, 0, intr.K.cx, 0, intr.K.fy, intr.K.cy, 0, 0, 1]);
    const d = intr.dist;
    const dist = cv.matFromArray(1, 5, cv.CV_64F, [d.k1, d.k2, d.p1, d.p2, d.k3]);
    const rvec = new cv.Mat();
    const tvec = new cv.Mat();
    const R = new cv.Mat();
    try {
      // 平面のボードなのでIPPEで解く（なければ既定の反復法）
      const flag = cv.SOLVEPNP_IPPE ?? cv.SOLVEPNP_ITERATIVE ?? 0;
      const ok = cv.solvePnP(obj, img, K, dist, rvec, tvec, false, flag);
      if (!ok) return null;
      cv.Rodrigues(rvec, R);
      const r = R.data64F;
      const t = tvec.data64F;
      return {
        R: [
          [r[0], r[1], r[2]],
          [r[3], r[4], r[5]],
          [r[6], r[7], r[8]],
        ],
        t: [t[0], t[1], t[2]],
      };
    } catch (e) {
      console.warn('OpenCVのsolvePnPに失敗しました', e);
      return null;
    } finally {
      [obj, img, K, dist, rvec, tvec, R].forEach((m) => m.delete());
    }
  }
}

class JsArucoDetector implements MarkerDetector {
  readonly name = 'js-aruco2' as const;
  private det: any;
  constructor(private maxId: number) {
    const AR = (window as any).AR;
    this.det = new AR.Detector({ dictionaryName: 'ARUCO_4X4_1000' });
  }
  detect(img: ImageData): DetectedMarker[] {
    const ms = this.det.detect(img) as { id: number; corners: { x: number; y: number }[] }[];
    return ms
      .filter((m) => m.id < this.maxId)
      .map((m) => ({ id: m.id, corners: m.corners.map((c) => [c.x, c.y] as [number, number]) }));
  }
}

async function loadJsAruco(dictionary: string): Promise<MarkerDetector> {
  const m = /^DICT_4X4_(\d+)$/.exec(dictionary);
  if (!m) throw new Error(`js-aruco2では辞書 ${dictionary} に対応していません（DICT_4X4_* のみ）`);
  await loadScript('/vendor/js-aruco2/cv.js');
  await loadScript('/vendor/js-aruco2/aruco.js');
  await loadScript('/vendor/js-aruco2/aruco_4x4_1000.js');
  return new JsArucoDetector(Number(m[1]));
}

export interface LoadedDetector {
  detector: MarkerDetector;
  loadMs: number;
  /** OpenCV.jsを試して失敗した場合の理由 */
  fallbackReason?: string;
}

export async function loadDetector(pref: DetectorPreference, dictionary: string): Promise<LoadedDetector> {
  const t0 = performance.now();
  if (pref !== 'js-aruco2') {
    try {
      const { cv } = await loadOpenCv();
      return { detector: new OpenCvDetector(cv, dictionary), loadMs: performance.now() - t0 };
    } catch (e) {
      if (pref === 'opencv') throw e;
      const reason = (e as Error).message;
      console.warn('OpenCV.jsが使えないため js-aruco2 に切り替えます:', reason);
      const d = await loadJsAruco(dictionary);
      return { detector: d, loadMs: performance.now() - t0, fallbackReason: reason };
    }
  }
  return { detector: await loadJsAruco(dictionary), loadMs: performance.now() - t0 };
}
